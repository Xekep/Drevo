import type pg from "pg";
import {
  applyArchiveChanges,
  archiveChanges,
  type Change,
} from "../domain/changes.ts";
import { isScopedUser } from "../domain/tree-access.ts";
import { isArchiveOwner } from "../domain/access.ts";
import { ConflictError } from "./archive-errors.ts";
import { hydrateArchive } from "./archive-hydration.ts";
import { authorizeArchive } from "./permissions.ts";
import { readPostgresArchiveInTransaction } from "./postgres-archive-read.ts";
import { ForbiddenError } from "./users.ts";
import {
  withPostgresArchiveWrite,
  rememberPostgresArchiveChange,
} from "./postgres-archive-write.ts";

// First write operation for the PostgreSQL cutover. Media attachment, creation,
// deletion and relations require their own authorization/quota operations.
// Sources, events and awards need the full citation/evidence and catalog-link checks.
const fields = new Set([
  "name",
  "surname",
  "patronymic",
  "sex",
  "birth",
  "death",
  "deceased",
  "needsReview",
  "birthPlace",
  "deathPlace",
  "birthLocation",
  "deathLocation",
  "maidenName",
  "occupation",
  "biography",
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

async function readPatchNeighborhood(
  client: pg.Client,
  archiveId: string,
  ids: string[],
) {
  const relations = await client.query(
    `SELECT id,source,target,type,note,twin_kind,created_by,sources,confidence FROM relations
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
  return withPostgresArchiveWrite(
    client,
    sessionToken,
    archiveId,
    expectedRevision,
    async (actor, revision) => {
      // Scoped edits retain the complete visibility checks. Ordinary edits only
      // load the cards and their incident relations, not every photo in a tree.
      const before = isScopedUser(actor)
        ? (await readPostgresArchiveInTransaction(client, archiveId)).family
        : await readPatchNeighborhood(client, archiveId, ids);
      const people = new Map(
        before.people.map((person) => [person.id, person]),
      );
      for (const id of ids) {
        const person = people.get(id);
        // A restricted editor must not distinguish a hidden ID from a missing ID.
        if (!isArchiveOwner(actor) && person?.createdBy !== actor.id)
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
                parentClaims: undefined,
                spouses: undefined,
              }),
            ],
          );
        }
      }
      return rememberPostgresArchiveChange(
        client,
        archiveId,
        before,
        after,
        actor,
        revision,
        "person-patches",
      );
    },
  );
}
