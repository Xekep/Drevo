import type pg from "pg";
import type { ArchiveUser } from "../domain/access.ts";
import { canEditArchive } from "../domain/access.ts";
import { archiveAudit } from "../domain/audit.ts";
import { archiveChanges, inverseChanges } from "../domain/changes.ts";
import type { Family } from "../domain/types.ts";
import { ConflictError } from "./archive-errors.ts";
import { postgresAccessReader, postgresUser } from "./postgres-access-read.ts";
import { sessionTokenHash, validSessionToken } from "./session-token.ts";
import { ForbiddenError } from "./users.ts";

function canEdit(user: ArchiveUser | null): user is ArchiveUser {
  return canEditArchive(user);
}

/** Owns the transaction on a dedicated connection. Never use inside BEGIN.
 * All graph writers lock archive -> session -> membership in the same order.
 * READ COMMITTED rechecks facts and rights after waiting for another writer.
 */
export async function withPostgresArchiveWrite<T>(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  expectedRevision: number,
  write: (actor: ArchiveUser, revision: number) => Promise<T>,
): Promise<T> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error("Некорректная ожидаемая ревизия");
  if (!validSessionToken(sessionToken) || !archiveId)
    throw new ForbiddenError("Нет доступа к архиву");
  const hash = sessionTokenHash(sessionToken);
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    await client.query("SELECT set_config('drevo.parent_evidence_write','on',true)");
    const preliminary = await postgresAccessReader(
      client,
      archiveId,
    ).getSessionUser(hash);
    if (!canEdit(preliminary))
      throw new ForbiddenError("Нет доступа к редактированию архива");
    const locked = await client.query(
      "SELECT revision FROM archives WHERE id=$1 FOR UPDATE",
      [archiveId],
    );
    if (!locked.rows[0]) throw new ForbiddenError("Нет доступа к архиву");
    const revision = Number(locked.rows[0].revision);
    const account = await client.query(
      "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT",
      [preliminary.id],
    );
    if (!account.rowCount) throw new ForbiddenError("Аккаунт больше не доступен");
    const session = (
      await client.query(
        "SELECT user_id,expires_at FROM account_sessions WHERE token_hash=$1 FOR SHARE",
        [hash],
      )
    ).rows[0];
    if (!session || Number(session.expires_at) <= Date.now())
      throw new ForbiddenError("Сессия завершена");
    const membership = (
      await client.query(
        `SELECT a.id,a.name,a.created_at,a.last_visit_at,m.role,m.role AS tree_role,
                m.approved,m.person_id,m.tree_access,
                (o.user_id IS NOT NULL) AS archive_owner,
                CASE WHEN pa.account_id IS NOT NULL THEN 'admin'
                     WHEN pr.account_id IS NOT NULL THEN 'researcher' ELSE NULL END AS global_role
         FROM archive_memberships m JOIN accounts a ON a.id=m.user_id
         LEFT JOIN archive_owners o ON o.archive_id=m.archive_id AND o.user_id=m.user_id
         LEFT JOIN platform_admins pa ON pa.account_id=m.user_id
         LEFT JOIN platform_researchers pr ON pr.account_id=m.user_id
        WHERE m.archive_id=$1 AND m.user_id=$2 FOR SHARE OF m`,
        [archiveId, session.user_id],
      )
    ).rows[0];
    const actor = membership ? postgresUser(membership) : null;
    if (!canEdit(actor) || Number(session.expires_at) <= Date.now())
      throw new ForbiddenError("Нет доступа к редактированию архива");
    const [admin, researcher] = [
      await client.query("SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT", [actor.id]),
      await client.query("SELECT account_id FROM platform_researchers WHERE account_id=$1 FOR SHARE NOWAIT", [actor.id]),
    ];
    if ((admin.rowCount ? "admin" : researcher.rowCount ? "researcher" : null) !==
        (actor.globalRole ?? null))
      throw new ForbiddenError("Глобальная роль изменилась");
    if (expectedRevision > revision)
      throw new ConflictError("Некорректная версия архива");
    const result = await write(actor, revision);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Caller owns the archive lock and has persisted the graph in this transaction. */
export async function rememberPostgresArchiveChange(
  client: pg.Client,
  archiveId: string,
  before: Family,
  after: Family,
  actor: ArchiveUser,
  revision: number,
  history: "snapshot" | "person-patches",
) {
  const appliedChanges = archiveChanges(before, after);
  if (!appliedChanges.length)
    return { revision, baseRevision: revision, appliedChanges };
  const at = new Date().toISOString();
  await client.query(
    "INSERT INTO history(archive_id,revision,saved_at,data) VALUES($1,$2,$3,$4::jsonb)",
    [
      archiveId,
      revision,
      at,
      JSON.stringify(
        history === "snapshot"
          ? before
          : {
              format: "drevo-person-patches-v1",
              changes: inverseChanges(appliedChanges),
            },
      ),
    ],
  );
  // The archive lock serializes IDs with imported historical audit entries.
  let auditId = BigInt(
    (
      await client.query(
        "SELECT COALESCE(MAX(id),0)::text AS id FROM archive_audit_entries WHERE archive_id=$1",
        [archiveId],
      )
    ).rows[0].id,
  );
  for (const draft of archiveAudit(before, after)) {
    auditId += BigInt(1);
    await client.query(
      `INSERT INTO archive_audit_entries(archive_id,id,at,actor_id,actor_name,action,entity,entity_id,label,revision,details)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`,
      [
        archiveId,
        auditId.toString(),
        at,
        actor.id,
        actor.name,
        draft.action,
        draft.entity,
        draft.entityId,
        draft.label,
        revision + 1,
        JSON.stringify(draft.details),
      ],
    );
    for (const personId of new Set(draft.personIds))
      await client.query(
        "INSERT INTO archive_audit_people(archive_id,entry_id,person_id) VALUES($1,$2,$3)",
        [archiveId, auditId.toString(), personId],
      );
  }
  await client.query("UPDATE archives SET revision=$2 WHERE id=$1", [
    archiveId,
    revision + 1,
  ]);
  await client.query(
    `DELETE FROM history WHERE archive_id=$1 AND revision NOT IN
      (SELECT revision FROM history WHERE archive_id=$1 ORDER BY revision DESC LIMIT 50)`,
    [archiveId],
  );
  return { revision: revision + 1, baseRevision: revision, appliedChanges };
}
