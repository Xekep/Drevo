import type { ArchiveUser } from "../domain/access.ts";
import { accountCapacity } from "./account-capacity.ts";
import { assertActiveAccountSession } from "./account-session-guard.ts";
import { auditStore } from "./audit.ts";
import { ConflictError } from "./database.ts";
import type { StoreDatabase } from "./store-database.ts";
import { assertCurrentArchiveActor, ForbiddenError } from "./users.ts";

const PROPOSAL_LIFETIME = 7 * 24 * 60 * 60_000;

type TransferRow = {
  from_user_id: string;
  to_user_id: string;
  target_name: string;
  source_name: string;
  created_ms: number;
  expires_ms: number;
};

async function ownerId(db: StoreDatabase, lock = false) {
  const row = await db
    .prepare(
      "",
      `SELECT user_id FROM archive_owners
       WHERE archive_id=current_setting('drevo.archive_id', true)${lock ? " FOR UPDATE" : ""}`,
    )
    .get();
  return row ? String(row.user_id) : null;
}

async function pending(db: StoreDatabase, lock = false) {
  const row = await db
    .prepare(
      "",
      `SELECT t.from_user_id,t.to_user_id,a.name AS target_name,
              source.name AS source_name,t.created_ms,t.expires_ms
       FROM archive_owner_transfers t
       JOIN accounts a ON a.id=t.to_user_id
       JOIN accounts source ON source.id=t.from_user_id
       WHERE t.archive_id=current_setting('drevo.archive_id', true)${lock ? " FOR UPDATE OF t" : ""}`,
    )
    .get();
  return row as TransferRow | undefined;
}

/** The account-directory RLS policy allows an account to see its own owner row
 * across archives. Use a transaction-local identity only for this lookup, then
 * restore the request context before doing any other work. The unique owner
 * index remains the final concurrent-transfer guard. */
async function ownsAnyArchive(db: StoreDatabase, accountId: string) {
  const previous = await db
    .prepare("", "SELECT current_setting('drevo.account_id', true) AS id")
    .get();
  await db
    .prepare("", "SELECT set_config('drevo.account_id',?,true)")
    .get(accountId);
  try {
    return !!(await db
      .prepare("", "SELECT 1 FROM archive_owners WHERE user_id=? LIMIT 1")
      .get(accountId));
  } finally {
    await db
      .prepare("", "SELECT set_config('drevo.account_id',?,true)")
      .get(String(previous?.id || ""));
  }
}

async function basicCapacityError(db: StoreDatabase, currentOwnerId: string) {
  const capacity = await accountCapacity(db, currentOwnerId);
  if (!capacity.available || !capacity.owned)
    return "Не удалось проверить квоту дерева";
  if (capacity.people > capacity.peopleLimit)
    return "Дерево превышает лимит 150 человек для базового аккаунта получателя";
  if (
    capacity.mediaBytes === null ||
    capacity.mediaBytes > capacity.mediaLimitBytes
  )
    return "Фотографии и документы превышают лимит 500 МБ для базового аккаунта получателя";
  return null;
}

async function assertCanOwn(
  db: StoreDatabase,
  currentOwnerId: string,
  targetId: string,
) {
  const target = await db
    .prepare(
      "",
      `SELECT a.name,m.role,t.full_access
       FROM archive_memberships m
       JOIN accounts a ON a.id=m.user_id
       JOIN account_tiers t ON t.account_id=m.user_id
       WHERE m.archive_id=current_setting('drevo.archive_id', true)
         AND m.user_id=? AND m.approved=true
       FOR SHARE OF m,t`,
    )
    .get(targetId);
  if (!target)
    throw new ConflictError("Получатель больше не участвует в этом дереве");
  if (await ownsAnyArchive(db, targetId))
    throw new ConflictError("Получатель уже владеет другим деревом");
  if (!target.full_access) {
    const error = await basicCapacityError(db, currentOwnerId);
    if (error) throw new ConflictError(error);
  }
  return { name: String(target.name), role: String(target.role) };
}

export function archiveOwnerTransfer(db: StoreDatabase) {
  async function requirePostgres() {
    if (db.kind !== "postgres")
      throw new ConflictError(
        "Передача владения доступна для личных деревьев PostgreSQL",
      );
  }

  return {
    async status(actor: ArchiveUser) {
      await requirePostgres();
      await assertCurrentArchiveActor(db, actor);
      const owner = await ownerId(db);
      const transfer = await pending(db);
      return {
        owner: owner === actor.id,
        incoming:
          transfer &&
          transfer.to_user_id === actor.id &&
          transfer.from_user_id === owner &&
          transfer.expires_ms > Date.now()
            ? { fromName: transfer.source_name, expiresAt: transfer.expires_ms }
            : null,
        outgoing:
          transfer &&
          transfer.from_user_id === actor.id &&
          transfer.from_user_id === owner &&
          transfer.expires_ms > Date.now()
            ? {
                targetId: transfer.to_user_id,
                targetName: transfer.target_name,
                expiresAt: transfer.expires_ms,
              }
            : null,
      };
    },

    async candidates(actor: ArchiveUser, search: string) {
      await requirePostgres();
      const query = search.trim().slice(0, 80);
      return await db.transaction(async () => {
        await assertCurrentArchiveActor(db, actor);
        if ((await ownerId(db)) !== actor.id)
          throw new ForbiddenError(
            "Только владелец может предложить передачу дерева",
          );
        const rows = await db
          .prepare(
            "",
            `SELECT m.user_id AS id,a.name,m.role,t.full_access,
                    t.account_id IS NOT NULL AS tier_present
             FROM archive_memberships m JOIN accounts a ON a.id=m.user_id
             LEFT JOIN account_tiers t ON t.account_id=m.user_id
             WHERE m.archive_id=current_setting('drevo.archive_id', true)
               AND m.approved=true AND m.user_id<>?
               AND (?='' OR position(lower(?) in lower(a.name))>0)
             ORDER BY a.name,m.user_id LIMIT 20`,
          )
          .all(actor.id, query, query);
        const candidates = [];
        let capacityError: string | null | undefined;
        for (const row of rows) {
          const owns = await ownsAnyArchive(db, String(row.id));
          if (!owns && row.tier_present && !row.full_access && capacityError === undefined)
            capacityError = await basicCapacityError(db, actor.id);
          const eligible = !owns && row.tier_present === true &&
            (row.full_access === true || !capacityError);
          candidates.push({
            id: String(row.id),
            name: String(row.name),
            role: String(row.role),
            eligible,
            ...(!eligible ? { reason: "unavailable" } : {}),
          });
        }
        return candidates;
      }, true);
    },

    async propose(actor: ArchiveUser, targetId: string, sessionTokenHash: string) {
      await requirePostgres();
      return await db.transaction(async () => {
        const transaction = db;
        await assertActiveAccountSession(transaction, actor.id, sessionTokenHash);
        await assertCurrentArchiveActor(transaction, actor);
        if ((await ownerId(transaction, true)) !== actor.id)
          throw new ForbiddenError(
            "Только владелец может предложить передачу дерева",
          );
        if (!targetId || targetId === actor.id)
          throw new ConflictError("Выберите другого участника дерева");
        const target = await assertCanOwn(transaction, actor.id, targetId);
        const now = Date.now();
        await transaction
          .prepare(
            "",
            `INSERT INTO archive_owner_transfers
             (archive_id,from_user_id,to_user_id,created_ms,expires_ms)
             VALUES(current_setting('drevo.archive_id', true),?,?,?,?)
             ON CONFLICT(archive_id) DO UPDATE SET
               from_user_id=excluded.from_user_id,to_user_id=excluded.to_user_id,
               created_ms=excluded.created_ms,expires_ms=excluded.expires_ms`,
          )
          .run(actor.id, targetId, now, now + PROPOSAL_LIFETIME);
        await auditStore(transaction).record(
          {
            action: "Предложена передача владения деревом",
            entity: "user",
            entityId: targetId,
            label: target.name,
            personIds: [],
            details: [],
          },
          actor,
        );
        return {
          targetId,
          targetName: target.name,
          expiresAt: now + PROPOSAL_LIFETIME,
        };
      });
    },

    async accept(actor: ArchiveUser, sessionTokenHash: string) {
      await requirePostgres();
      return await db.transaction(async () => {
        const transaction = db;
        await assertActiveAccountSession(transaction, actor.id, sessionTokenHash);
        await assertCurrentArchiveActor(transaction, actor);
        const currentOwner = await ownerId(transaction, true);
        const transfer = await pending(transaction, true);
        if (
          !currentOwner ||
          !transfer ||
          transfer.from_user_id !== currentOwner ||
          transfer.to_user_id !== actor.id ||
          transfer.expires_ms <= Date.now()
        )
          throw new ConflictError(
            "Предложение о передаче владения истекло или отозвано",
          );
        await assertCanOwn(transaction, currentOwner, actor.id);
        await transaction
          .prepare(
            "",
            `UPDATE archive_memberships SET role='admin',tree_access='all'
             WHERE archive_id=current_setting('drevo.archive_id', true)
               AND user_id=? AND approved=true`,
          )
          .run(actor.id);
        const updated = await transaction
          .prepare(
            "",
            `UPDATE archive_owners SET user_id=?
             WHERE archive_id=current_setting('drevo.archive_id', true) AND user_id=?`,
          )
          .run(actor.id, currentOwner);
        if (updated.changes !== 1)
          throw new ConflictError(
            "Владелец дерева изменился. Обновите страницу",
          );
        await transaction
          .prepare(
            "",
            `UPDATE archive_memberships SET role='relative'
             WHERE archive_id=current_setting('drevo.archive_id', true) AND user_id=?`,
          )
          .run(currentOwner);
        await transaction
          .prepare(
            "",
            "DELETE FROM archive_owner_transfers WHERE archive_id=current_setting('drevo.archive_id', true)",
          )
          .run();
        await auditStore(transaction).record(
          {
            action: "Передано владение деревом",
            entity: "user",
            entityId: actor.id,
            label: transfer.target_name,
            personIds: [],
            details: [
              { field: "Владелец", before: currentOwner, after: actor.id },
            ],
          },
          actor,
        );
        return { ownerId: actor.id };
      });
    },

    async cancel(actor: ArchiveUser, sessionTokenHash: string) {
      await requirePostgres();
      return await db.transaction(async () => {
        const transaction = db;
        await assertActiveAccountSession(transaction, actor.id, sessionTokenHash);
        await assertCurrentArchiveActor(transaction, actor);
        const currentOwner = await ownerId(transaction, true);
        const transfer = await pending(transaction, true);
        if (
          !transfer ||
          transfer.from_user_id !== currentOwner ||
          (actor.id !== currentOwner && actor.id !== transfer.to_user_id)
        )
          throw new ForbiddenError(
            "Нет предложения о передаче, которое вы можете отклонить",
          );
        await transaction
          .prepare(
            "",
            "DELETE FROM archive_owner_transfers WHERE archive_id=current_setting('drevo.archive_id', true)",
          )
          .run();
        await auditStore(transaction).record(
          {
            action: "Отменена передача владения деревом",
            entity: "user",
            entityId: transfer.to_user_id,
            label: transfer.target_name,
            personIds: [],
            details: [],
          },
          actor,
        );
        return { cancelled: true };
      });
    },
  };
}
