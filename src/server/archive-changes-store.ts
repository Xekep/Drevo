import type { ArchiveUser } from "../domain/access.ts";
import {
  applyArchiveChanges,
  archiveChanges,
  inverseChanges,
  type Change,
} from "../domain/changes.ts";
import { visiblePersonIds, isScopedUser } from "../domain/tree-access.ts";
import { ConflictError } from "./archive-errors.ts";
import { readArchiveForChanges } from "./archive-change-read.ts";
import { archiveRows } from "./archive-rows.ts";
import { syncArchiveRows } from "./archive-row-mutations.ts";
import { authorizeArchive } from "./permissions.ts";
import { authorizeMediaReferences } from "./media-access.ts";
import { assertCatalogLinks, allCitations } from "./source-catalog-store.ts";
import { checkStorePostgresPeopleGrowth } from "./postgres-people-quota.ts";
import {
  enforcePostgresMediaQuota,
  postgresMediaBytes,
  releaseAttachedMediaGrants,
} from "./postgres-media-quota.ts";
import { enforceUserStorageLimit, userStorageBytes } from "./storage-limits.ts";
import { auditStore } from "./audit.ts";
import { ForbiddenError, assertCurrentArchiveActor } from "./users.ts";
import type { StoreDatabase } from "./store-database.ts";

/** Live StoreDatabase mutation owner. Full JSON is read only for delta targets;
 * a compact graph retains global cycle/date/scope validation. Both engines use
 * the ordinary archive-locked transaction and the same domain permissions. */
export async function patchArchiveChanges(
  db: StoreDatabase,
  changes: Change[],
  expected: number,
  actor: ArchiveUser,
  options: { withinTransaction?: boolean } = {},
) {
  if (!actor.approved || actor.role === "reader")
    throw new ForbiddenError("Доступен только просмотр архива");
  const apply = async () => {
    await assertCurrentArchiveActor(db, actor);
    const {
      family: before,
      revision,
      completePeople,
    } = await readArchiveForChanges(db, changes);
    if (expected > revision)
      throw new ConflictError("Некорректная версия архива");
    const merged = applyArchiveChanges(before, changes);
    if (merged.conflicts.length)
      throw new ConflictError(
        "Изменяемые сведения уже обновлены другим участником",
      );
    const after = authorizeArchive(merged.family, before, actor);
    const appliedChanges = archiveChanges(before, after);
    if (!appliedChanges.length)
      return { revision, baseRevision: revision, appliedChanges };
    // Never let a partial projection overwrite an unrelated person's details.
    for (const change of appliedChanges)
      if (change.collection === "people" && !completePeople.has(change.id!))
        throw new Error("Изменяемая карточка не загружена полностью");
    await checkStorePostgresPeopleGrowth(
      db,
      after.people.length - before.people.length,
    );
    await assertCatalogLinks(db, after);
    await authorizeMediaReferences(db, before, after, actor, {
      persistedVisibleIds: isScopedUser(actor)
        ? visiblePersonIds(before, actor)
        : undefined,
    });
    const urls = (family: typeof before) =>
      new Set(
        [
          ...family.people.map((person) => person.photo),
          ...(family.photos || []).map((photo) => photo.url),
          ...allCitations(family).map(
            (citation) => citation.url?.split(/[?#]/, 1)[0],
          ),
        ].filter((url): url is string => !!url?.startsWith("/media/")),
      );
    const oldUrls = urls(before),
      nextUrls = urls(after);
    const mediaAdded = [...nextUrls].some((url) => !oldUrls.has(url));
    const mediaChanged =
      mediaAdded || [...oldUrls].some((url) => !nextUrls.has(url));
    const measuredAt = Date.now();
    const archiveBytesBefore = mediaAdded
      ? await postgresMediaBytes(db, measuredAt)
      : 0;
    const userBytesBefore = mediaAdded
      ? await userStorageBytes(db, actor.id, measuredAt)
      : 0;
    await syncArchiveRows(db, archiveRows(before), archiveRows(after), {
      partialPhotos: true,
    });
    if (mediaChanged) await releaseAttachedMediaGrants(db);
    if (mediaAdded) {
      await enforcePostgresMediaQuota(db, archiveBytesBefore, measuredAt);
      await enforceUserStorageLimit(
        db,
        actor.id,
        0,
        false,
        measuredAt,
        userBytesBefore,
      );
    }
    await db
      .prepare(
        "INSERT INTO history(revision,data) VALUES(?,?)",
        "INSERT INTO history(revision,data) VALUES(?,?)",
      )
      .run(
        revision,
        JSON.stringify({
          format: "drevo-archive-changes-v1",
          changes: inverseChanges(appliedChanges),
          owners: Object.fromEntries(
            before.people
              .filter((person) => completePeople.has(person.id))
              .map((person) => [person.id, person.createdBy || null]),
          ),
        }),
      );
    await auditStore(db).archive(before, after, actor, revision + 1);
    await db
      .prepare(
        "UPDATE archive SET title=?,description=?,demo=?,revision=? WHERE id=1",
        "UPDATE archives SET title=?,description=?,demo=(?::integer<>0),revision=? WHERE id=current_setting('drevo.archive_id',true)",
      )
      .run(after.title, after.description, Number(after.demo), revision + 1);
    await db.exec(
      "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50)",
      "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50)",
    );
    return { revision: revision + 1, baseRevision: revision, appliedChanges };
  };
  if (options.withinTransaction) {
    if (!db.inTransaction()) throw new Error("Ожидается транзакция архива");
    return await apply();
  }
  return await db.transaction(apply);
}
