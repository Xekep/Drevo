import { createHash, randomBytes, randomUUID } from "node:crypto";
import type pg from "pg";
import type { ArchiveUser } from "../domain/access.ts";
import type { StoreDatabase } from "./store-database.ts";
import { assertCurrentArchiveActor } from "./users.ts";
import { AccountSessionBusy, AccountSessionExpired } from "./account-session-guard.ts";

const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const archivePattern = /^[A-Za-z0-9][A-Za-z0-9-]{2,63}$/;
const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export class InvalidInvitationError extends Error {}

/** Admin operations stay inside the current archive's RLS context. */
export function archiveInvitations(db: StoreDatabase) {
  const list =
    db.kind === "postgres"
      ? db.prepare(
          "",
          `SELECT id,role,created_by,created_at,expires_at,used_by,used_at,revoked_at
        FROM archive_invitations
        ORDER BY (used_at IS NULL AND revoked_at IS NULL AND expires_at>?) DESC,
                 created_at DESC,id DESC LIMIT 150`,
        )
      : null;
  const activeCount =
    db.kind === "postgres"
      ? db.prepare(
          "",
          `SELECT count(*) AS n FROM archive_invitations
        WHERE used_at IS NULL AND revoked_at IS NULL AND expires_at>?`,
        )
      : null;
  const insert =
    db.kind === "postgres"
      ? db.prepare(
          "",
          `INSERT INTO archive_invitations
        (archive_id,id,token_hash,role,created_by,created_at,expires_at)
        VALUES(?,?,?,?,?,?,?)`,
        )
      : null;
  const revoke =
    db.kind === "postgres"
      ? db.prepare(
          "",
          `UPDATE archive_invitations SET revoked_at=?
        WHERE id=?::uuid AND used_at IS NULL AND revoked_at IS NULL`,
        )
      : null;
  const requireAdmin = (actor: ArchiveUser) => {
    if (actor.role !== "admin" || !actor.approved)
      throw new InvalidInvitationError(
        "Приглашениями управляет администратор дерева.",
      );
  };
  return {
    async list(actor: ArchiveUser) {
      requireAdmin(actor);
      if (!list)
        throw new InvalidInvitationError("Приглашения доступны с PostgreSQL.");
      return await db.transaction(async () => {
        await assertCurrentArchiveActor(db, actor);
        return (await list.all(new Date().toISOString())).map((row) => ({
          id: String(row.id),
          role: String(row.role),
          createdAt: String(row.created_at),
          expiresAt: String(row.expires_at),
          usedAt: row.used_at ? String(row.used_at) : null,
          revokedAt: row.revoked_at ? String(row.revoked_at) : null,
        }));
      }, true);
    },
    async create(actor: ArchiveUser, role: unknown, durationHours: unknown) {
      requireAdmin(actor);
      const archiveId = db.archiveId;
      if (!insert || !activeCount || !archiveId)
        throw new InvalidInvitationError("Приглашения доступны с PostgreSQL.");
      if (
        (role !== "reader" && role !== "relative") ||
        ![24, 168, 720].includes(durationHours as number)
      )
        throw new InvalidInvitationError("Выберите роль и срок приглашения.");
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + Number(durationHours) * 3600000,
      ).toISOString();
      const token = randomBytes(32).toString("base64url");
      const id = randomUUID();
      await db.transaction(async () => {
        await assertCurrentArchiveActor(db, actor);
        const count = await activeCount.get(now.toISOString());
        if (Number(count?.n || 0) >= 100)
          throw new InvalidInvitationError(
            "Сначала отзовите неиспользованные приглашения.",
          );
        await insert.run(
          archiveId,
          id,
          hash(token),
          role,
          actor.id,
          now.toISOString(),
          expiresAt,
        );
      });
      return {
        id,
        role,
        expiresAt,
        path: `/join/${archiveId}/${token}`,
      };
    },
    async revoke(actor: ArchiveUser, id: string) {
      requireAdmin(actor);
      if (!revoke)
        throw new InvalidInvitationError("Приглашения доступны с PostgreSQL.");
      if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id))
        throw new InvalidInvitationError("Приглашение не найдено.");
      return await db.transaction(async () => {
        await assertCurrentArchiveActor(db, actor);
        return (await revoke.run(new Date().toISOString(), id)).changes > 0;
      });
    },
  };
}

/** Token lookup and membership grant are one transaction under target RLS. */
export function accountInvitations(db: StoreDatabase) {
  const validate = (archiveId: string, token: string) => {
    if (!archivePattern.test(archiveId) || !tokenPattern.test(token))
      throw new InvalidInvitationError("Приглашение недействительно.");
  };
  const withInvitation = async <T>(
    archiveId: string,
    token: string,
    work: (
      client: pg.PoolClient,
      invite: { id: string; role: string; used_by: string | null },
    ) => Promise<T>,
    lock = false,
    session?: { accountId: string; tokenHash: string },
  ) => {
    validate(archiveId, token);
    if (!db.postgresTransaction)
      throw new InvalidInvitationError("Приглашения доступны с PostgreSQL.");
    return await db.postgresTransaction(async (client) => {
      await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
        archiveId,
      ]);
      if (session) {
        // Account deletion holds the session before locking memberships'
        // archives. Take the archive first and use NOWAIT on the session to
        // avoid waiting across the opposite lock order.
        const archive = await client.query("SELECT id FROM archives WHERE id=$1 FOR UPDATE", [archiveId]);
        if (!archive.rowCount)
          throw new InvalidInvitationError("Приглашение недействительно.");
        let active: pg.QueryResult<{ expires_at: number }>;
        try {
          active = await client.query<{ expires_at: number }>(
            `SELECT expires_at FROM account_sessions
             WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [session.tokenHash, session.accountId],
          );
        } catch (error) {
          if ((error as { code?: string }).code === "55P03")
            throw new AccountSessionBusy("Сеанс занят другим действием. Повторите запрос");
          throw error;
        }
        if (!active.rowCount || Number(active.rows[0].expires_at) <= Date.now())
          throw new AccountSessionExpired("Сессия завершена. Войдите снова");
      }
      const result = await client.query<{
        id: string;
        role: string;
        used_by: string | null;
      }>(
        `SELECT id,role,used_by FROM archive_invitations
         WHERE archive_id=$1 AND token_hash=$2 AND revoked_at IS NULL AND expires_at>$3
         ${lock ? "FOR UPDATE" : ""}`,
        [archiveId, hash(token), new Date().toISOString()],
      );
      const invite = result.rows[0];
      if (!invite)
        throw new InvalidInvitationError(
          "Приглашение недействительно или срок истёк.",
        );
      return await work(client, invite);
    });
  };
  return {
    async preview(archiveId: string, token: string) {
      return await withInvitation(archiveId, token, async (client, invite) => {
        if (invite.used_by)
          throw new InvalidInvitationError("Приглашение уже использовано.");
        const archive = await client.query<{ title: string }>(
          "SELECT title FROM archives WHERE id=$1",
          [archiveId],
        );
        return {
          archiveId,
          title: archive.rows[0]?.title || "Семейное древо",
          role: invite.role,
        };
      });
    },
    async accept(archiveId: string, token: string, accountId: string, tokenHash: string) {
      if (!accountId)
        throw new InvalidInvitationError("Войдите, чтобы принять приглашение.");
      return await withInvitation(
        archiveId,
        token,
        async (client, invite) => {
          if (invite.used_by && invite.used_by !== accountId)
            throw new InvalidInvitationError("Приглашение уже использовано.");
          if (!invite.used_by) {
            await client.query(
              `INSERT INTO archive_memberships
              (archive_id,user_id,role,approved,person_id,tree_access)
             VALUES($1,$2,$3,true,NULL,'all')
             ON CONFLICT (archive_id,user_id) DO UPDATE SET
               approved=true,
               role=CASE
                 WHEN archive_memberships.role='admin' OR archive_memberships.approved
                   THEN archive_memberships.role
                 ELSE EXCLUDED.role END,
               tree_access=CASE WHEN archive_memberships.approved
                 THEN archive_memberships.tree_access ELSE 'all' END`,
              [archiveId, accountId, invite.role],
            );
            await client.query(
              "UPDATE archive_invitations SET used_by=$2,used_at=$3 WHERE id=$1::uuid",
              [invite.id, accountId, new Date().toISOString()],
            );
          }
          return { archiveId, path: `/a/${archiveId}/tree` };
        },
        true,
        { accountId, tokenHash },
      );
    },
  };
}
