import type pg from "pg";
import {
  applyArchiveChanges,
  inverseChanges,
  type Change,
} from "../domain/changes.ts";
import { removePerson } from "../domain/mutations.ts";
import { isArchiveOwner } from "../domain/access.ts";
import { ConflictError } from "./archive-errors.ts";
import { authorizeArchive } from "./permissions.ts";
import { readPostgresArchiveInTransaction } from "./postgres-archive-read.ts";
import {
  withPostgresArchiveWrite,
  rememberPostgresArchiveChange,
} from "./postgres-archive-write.ts";
import { persistPostgresGraphChanges } from "./postgres-graph-rows.ts";
import { checkPostgresPeopleGrowth } from "./postgres-people-quota.ts";
import { enforcePostgresArchiveMediaQuota, postgresArchiveMediaBytes } from "./postgres-media-quota.ts";
import {
  capturePersonRemovalDependencies,
  restorePersonRemovalDependencies,
} from "./postgres-person-removal-dependencies.ts";
import { ForbiddenError } from "./users.ts";

function validateRequestId(id: string) {
  if (
    typeof id !== "string" ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error("Некорректный идентификатор операции удаления");
}

/** Admin-only, matching SQLite permissions. This is not yet exposed over HTTP.
 * requestId belongs to one deletion attempt; retries must reuse it.
 * Exact revision protects the complete cascade, not only the person's fields.
 */
export async function removePostgresPersonForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  personId: string,
  requestId: string,
  expectedRevision: number,
) {
  validateRequestId(requestId);
  if (typeof personId !== "string" || !personId || personId.length > 200)
    throw new Error("Некорректный ID человека");
  return withPostgresArchiveWrite(
    client,
    sessionToken,
    archiveId,
    expectedRevision,
    async (actor, revision) => {
      if (!isArchiveOwner(actor))
        throw new ForbiddenError("Удалять людей может только администратор");
      const previous = (
        await client.query(
          "SELECT actor_id,person_id,base_revision,restored_revision FROM person_removals WHERE archive_id=$1 AND request_id=$2",
          [archiveId, requestId],
        )
      ).rows[0];
      if (previous) {
        if (
          previous.actor_id !== actor.id ||
          previous.person_id !== personId ||
          Number(previous.base_revision) !== expectedRevision
        )
          throw new ConflictError("Идентификатор операции уже использован");
        return {
          revision,
          baseRevision: revision,
          appliedChanges: [] as Change[],
          requestId,
          status:
            previous.restored_revision === null
              ? ("removed" as const)
              : ("restored" as const),
        };
      }
      if (expectedRevision !== revision)
        throw new ConflictError(
          "Архив изменился. Обновите сведения перед удалением человека",
        );
      const locked = await client.query(
        "SELECT id FROM people WHERE archive_id=$1 AND id=$2 FOR UPDATE",
        [archiveId, personId],
      );
      if (!locked.rowCount)
        throw new ConflictError("Человек уже удалён или не найден");
      const dependencies = await capturePersonRemovalDependencies(
        client,
        archiveId,
        personId,
      );
      const before = (await readPostgresArchiveInTransaction(client, archiveId))
        .family;
      const after = authorizeArchive(
        removePerson(before, personId),
        before,
        actor,
      );
      await persistPostgresGraphChanges(client, archiveId, before, after);
      const persisted = (
        await readPostgresArchiveInTransaction(client, archiveId)
      ).family;
      const result = await rememberPostgresArchiveChange(
        client,
        archiveId,
        before,
        persisted,
        actor,
        revision,
        "snapshot",
      );
      await client.query(
        `INSERT INTO person_removals(archive_id,request_id,actor_id,person_id,base_revision,inverse_changes,dependencies)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
        [
          archiveId,
          requestId,
          actor.id,
          personId,
          revision,
          JSON.stringify(inverseChanges(result.appliedChanges)),
          JSON.stringify(dependencies),
        ],
      );
      return { ...result, requestId, status: "removed" as const };
    },
  );
}

/** Undo uses a server-owned receipt, never client-supplied authors, files or
 * comments. Independent later edits survive; overlapping edits fail atomically.
 * Receipt lifetime is the same 50-revision history window as other changes.
 */
export async function restorePostgresPersonForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  requestId: string,
  expectedRevision: number,
) {
  validateRequestId(requestId);
  return withPostgresArchiveWrite(
    client,
    sessionToken,
    archiveId,
    expectedRevision,
    async (actor, revision) => {
      if (!isArchiveOwner(actor))
        throw new ForbiddenError(
          "Восстанавливать людей может только администратор",
        );
      const receipt = (
        await client.query(
          "SELECT * FROM person_removals WHERE archive_id=$1 AND request_id=$2 FOR UPDATE",
          [archiveId, requestId],
        )
      ).rows[0];
      if (!receipt || receipt.actor_id !== actor.id)
        throw new ForbiddenError(
          "Операция отмены недоступна или срок её хранения истёк",
        );
      if (receipt.restored_revision !== null)
        return {
          revision,
          baseRevision: revision,
          appliedChanges: [] as Change[],
          requestId,
          status: "restored" as const,
        };
      const before = (await readPostgresArchiveInTransaction(client, archiveId))
        .family;
      if (before.people.some((person) => person.id === receipt.person_id))
        throw new ConflictError(
          "ID удалённого человека уже занят; восстановление не применено",
        );
      const merged = applyArchiveChanges(before, receipt.inverse_changes);
      if (merged.conflicts.length)
        throw new ConflictError(
          "Связанные сведения изменились после удаления. Отмена не применена",
        );
      const after = authorizeArchive(merged.family, before, actor);
      await checkPostgresPeopleGrowth(
        client,
        archiveId,
        after.people.length - before.people.length,
      );
      const mediaBytesBefore = await postgresArchiveMediaBytes(client, archiveId);
      await persistPostgresGraphChanges(client, archiveId, before, after);
      await restorePersonRemovalDependencies(
        client,
        archiveId,
        receipt.person_id,
        receipt.dependencies,
      );
      await enforcePostgresArchiveMediaQuota(client, archiveId, mediaBytesBefore);
      const persisted = (
        await readPostgresArchiveInTransaction(client, archiveId)
      ).family;
      const result = await rememberPostgresArchiveChange(
        client,
        archiveId,
        before,
        persisted,
        actor,
        revision,
        "snapshot",
      );
      await client.query(
        "UPDATE person_removals SET restored_revision=$3 WHERE archive_id=$1 AND request_id=$2",
        [archiveId, requestId, result.revision],
      );
      return { ...result, requestId, status: "restored" as const };
    },
  );
}
