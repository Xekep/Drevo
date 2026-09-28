import type pg from "pg";
import type { ArchiveUser } from "../domain/access.ts";
import { archiveAudit } from "../domain/audit.ts";
import {
  applyArchiveChanges,
  archiveChanges,
  inverseChanges,
  type Change,
} from "../domain/changes.ts";
import { isScopedUser } from "../domain/tree-access.ts";
import { ConflictError } from "./archive-errors.ts";
import { hydrateArchive } from "./archive-hydration.ts";
import { authorizeArchive } from "./permissions.ts";
import { postgresAccessReader, postgresUser } from "./postgres-access-read.ts";
import { readPostgresArchiveInTransaction } from "./postgres-archive-read.ts";
import { sessionTokenHash, validSessionToken } from "./session-token.ts";
import { ForbiddenError } from "./users.ts";

// First write operation for the PostgreSQL cutover. Media attachment, creation,
// deletion and relations require their own authorization/quota operations.
const fields = new Set([
  "name",
  "surname",
  "patronymic",
  "sex",
  "birth",
  "death",
  "deceased",
  "birthPlace",
  "deathPlace",
  "birthLocation",
  "deathLocation",
  "maidenName",
  "occupation",
  "biography",
  "sources",
  "awards",
  "events",
  "parentageComplete",
  "generation",
  "column",
]);

function patchIds(changes: Change[], expectedRevision: number) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error("Некорректная ожидаемая ревизия");
  if (
    !Array.isArray(changes) ||
    !changes.length ||
    changes.length > 10_000 ||
    !changes.every(
      (change) =>
        change &&
        change.collection === "people" &&
        typeof change.id === "string" &&
        change.id.length > 0 &&
        change.id.length <= 200 &&
        typeof change.field === "string" &&
        fields.has(change.field),
    )
  )
    throw new Error(
      "Ожидаются изменения полей существующих карточек без портретов и связей",
    );
  const ids = [...new Set(changes.map((change) => change.id!))];
  if (ids.length > 500)
    throw new Error("Слишком много карточек в одном изменении");
  return ids;
}

function canEdit(user: ArchiveUser | null): user is ArchiveUser {
  return (
    !!user?.approved && (user.role === "admin" || user.role === "relative")
  );
}

async function readPatchNeighborhood(
  client: pg.Client,
  archiveId: string,
  ids: string[],
) {
  const relations = await client.query(
    `SELECT id,source,target,type,note,created_by FROM relations
      WHERE archive_id=$1 AND (source=ANY($2::text[]) OR target=ANY($2::text[]))
      ORDER BY ordinal`,
    [archiveId, ids],
  );
  const related = [
    ...new Set([
      ...ids,
      ...relations.rows.flatMap((row) => [
        String(row.source),
        String(row.target),
      ]),
    ]),
  ];
  const people = await client.query(
    "SELECT data FROM people WHERE archive_id=$1 AND id=ANY($2::text[]) ORDER BY ordinal",
    [archiveId, related],
  );
  return hydrateArchive(
    { title: "", description: "", demo: false, revision: 0 },
    people.rows,
    relations.rows,
    [],
    [],
  ).family;
}

/**
 * Owns the transaction on an exclusively checked-out connection; not wired to
 * HTTP yet. READ COMMITTED re-reads facts and rights after waiting for a writer.
 * Lock order: archive revision -> session -> membership. All future archive
 * writers/audit appenders must use the same archive lock before changing rows.
 */
export async function patchPostgresPeopleForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  changes: Change[],
  expectedRevision: number,
) {
  const ids = patchIds(changes, expectedRevision);
  if (!validSessionToken(sessionToken) || !archiveId)
    throw new ForbiddenError("Нет доступа к архиву");
  const hash = sessionTokenHash(sessionToken);
  await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
  try {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '15s'");
    // Reject an unrelated account before taking an archive-wide write lock.
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
        `SELECT a.id,a.name,a.created_at,a.last_visit_at,
              m.role,m.approved,m.person_id,m.tree_access
         FROM archive_memberships m JOIN accounts a ON a.id=m.user_id
        WHERE m.archive_id=$1 AND m.user_id=$2 FOR SHARE OF m`,
        [archiveId, session.user_id],
      )
    ).rows[0];
    const actor = membership ? postgresUser(membership) : null;
    if (!canEdit(actor) || Number(session.expires_at) <= Date.now())
      throw new ForbiddenError("Нет доступа к редактированию архива");
    if (expectedRevision > revision)
      throw new ConflictError("Некорректная версия архива");

    // Scoped edits retain the complete visibility checks. Ordinary edits only
    // load the cards and their incident relations, not every photo in a tree.
    const before = isScopedUser(actor)
      ? (await readPostgresArchiveInTransaction(client, archiveId)).family
      : await readPatchNeighborhood(client, archiveId, ids);
    const people = new Map(before.people.map((person) => [person.id, person]));
    for (const id of ids) {
      const person = people.get(id);
      // A restricted editor must not distinguish a hidden ID from a missing ID.
      if (actor.role !== "admin" && person?.createdBy !== actor.id)
        throw new ForbiddenError("Можно редактировать только свои карточки");
      if (!person)
        throw new ConflictError("Карточка удалена другим участником");
    }
    const merged = applyArchiveChanges(before, changes);
    if (merged.conflicts.length)
      throw new ConflictError(
        "Изменяемые сведения уже обновлены другим участником",
      );
    // Shared SQLite/PostgreSQL validation checks dates of adjacent children too.
    const after = authorizeArchive(merged.family, before, actor);
    const appliedChanges = archiveChanges(before, after);
    const nextRevision = revision + Number(appliedChanges.length > 0);
    if (appliedChanges.length) {
      const changedIds = new Set(appliedChanges.map((change) => change.id));
      for (const person of after.people) {
        if (!changedIds.has(person.id)) continue;
        await client.query(
          "UPDATE people SET data=$3::jsonb WHERE archive_id=$1 AND id=$2",
          [
            archiveId,
            person.id,
            JSON.stringify({
              ...person,
              parents: undefined,
              spouses: undefined,
            }),
          ],
        );
      }
      const at = new Date().toISOString();
      await client.query(
        "INSERT INTO history(archive_id,revision,saved_at,data) VALUES($1,$2,$3,$4::jsonb)",
        [
          archiveId,
          revision,
          at,
          JSON.stringify({
            format: "drevo-person-patches-v1",
            changes: inverseChanges(appliedChanges),
          }),
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
            nextRevision,
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
        nextRevision,
      ]);
      await client.query(
        `DELETE FROM history WHERE archive_id=$1 AND revision NOT IN
          (SELECT revision FROM history WHERE archive_id=$1 ORDER BY revision DESC LIMIT 50)`,
        [archiveId],
      );
    }
    await client.query("COMMIT");
    return { revision: nextRevision, baseRevision: revision, appliedChanges };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}
