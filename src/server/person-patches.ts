import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { Family, FamilyLink, Person } from "../domain/types.ts";
import {
  applyArchiveChanges,
  archiveChanges,
  inverseChanges,
  type Change,
} from "../domain/changes.ts";
import { validateFamily } from "../domain/validation.ts";
import { ConflictError } from "./archive-errors.ts";
import { ForbiddenError, assertCurrentArchiveActor } from "./users.ts";
import { auditStore } from "./audit.ts";
import { authorizeMediaReferences } from "./media-access.ts";
import {
  enforcePostgresMediaQuota,
  postgresMediaBytes,
  releaseAttachedMediaGrants,
} from "./postgres-media-quota.ts";

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
  "photo",
  "sources",
  "awards",
  "events",
  "parentageComplete",
  "generation",
  "column",
]);

/** Existing card fields only. Structural changes retain whole-graph validation. */
export async function patchPeople(
  db: StoreDatabase,
  changes: Change[],
  expected: number,
  actor: ArchiveUser,
  options: { withinTransaction?: boolean } = {},
) {
  // Scoped writes retain the complete visibility/relationship authorization.
  if (actor.role !== "admin" && actor.treeAccess === "common_ancestors")
    return null;
  if (
    !changes.length ||
    !changes.every(
      (c) =>
        c.collection === "people" && c.id && c.field && fields.has(c.field),
    )
  )
    return null;
  const ids = [...new Set(changes.map((c) => c.id!))];
  if (ids.length > 500) return null;
  if (actor.role === "reader" || !actor.approved)
    throw new ForbiddenError("Доступен только просмотр архива");
  const apply = async () => {
    await assertCurrentArchiveActor(db, actor);
    const revision = Number(
      (await db
        .prepare(
          "SELECT revision FROM archive WHERE id=1",
          "SELECT revision FROM archives WHERE id=current_setting('drevo.archive_id', true)",
        )
        .get())!.revision,
    );
    if (expected > revision)
      throw new ConflictError("Некорректная версия архива");
    const selected = new Set(ids),
      related = new Set(ids);
    const placeholders = ids.map(() => "?").join(",");
    const relations = await db
      .prepare(
        `SELECT * FROM relations WHERE source IN (${placeholders}) OR target IN (${placeholders})`,
        `SELECT * FROM relations WHERE source IN (${placeholders}) OR target IN (${placeholders})`,
      )
      .all(...ids, ...ids);
    for (const row of relations) {
      related.add(String(row.source));
      related.add(String(row.target));
    }
    // One indexed set lookup instead of one network round trip per relative.
    // A JSON parameter avoids a growing SQL statement / binding-count limit.
    const rows = await db
      .prepare(
        "SELECT id,data FROM people WHERE id IN (SELECT value FROM json_each(?))",
        "SELECT id,data FROM people WHERE id IN (SELECT value FROM jsonb_array_elements_text(?::jsonb))",
      )
      .all(JSON.stringify([...related]));
    const byId = new Map(rows.map((row) => [String(row.id), row]));
    const people = [...related].map((id) => {
      const row = byId.get(id);
      if (!row) throw new ConflictError("Карточка удалена другим участником");
      return {
        ...JSON.parse(String(row.data)),
        parents: [],
        spouses: [],
      } as Person;
    });
    const map = new Map(people.map((p) => [p.id, p]));
    for (const id of ids)
      if (actor.role !== "admin" && map.get(id)!.createdBy !== actor.id)
        throw new ForbiddenError("Можно редактировать только свои карточки");
    const links: FamilyLink[] = [];
    for (const row of relations) {
      const from = String(row.source),
        to = String(row.target);
      if (row.type === "parent") map.get(to)!.parents.push(from);
      else if (row.type === "spouse") {
        map.get(from)!.spouses.push(to);
        map.get(to)!.spouses.push(from);
      } else
        links.push({
          id: String(row.id),
          from,
          to,
          type: row.type as FamilyLink["type"],
        });
    }
    const before: Family = {
      title: "",
      description: "",
      demo: false,
      people,
      links,
    };
    const merged = applyArchiveChanges(before, changes);
    if (merged.conflicts.length)
      throw new ConflictError(
        "Изменяемые сведения уже обновлены другим участником",
      );
    // All incident date constraints are checked, including children outside the edited set.
    const after = validateFamily(merged.family);
    const appliedChanges = archiveChanges(before, after);
    if (appliedChanges.length) {
      const photoChanged = appliedChanges.some(
        (change) => change.field === "photo",
      );
      const mediaChanged = appliedChanges.some(
        (change) =>
          change.field === "photo" ||
          change.field === "sources" ||
          change.field === "events",
      );
      if (photoChanged)
        await authorizeMediaReferences(db, before, after, actor);
      const measuredAt = Date.now();
      const mediaBytesBefore = mediaChanged
        ? await postgresMediaBytes(db, measuredAt)
        : 0;
      const update = db.prepare(
        "UPDATE people SET data=? WHERE id=?",
        "UPDATE people SET data=? WHERE id=?",
      );
      for (const person of after.people) {
        if (!selected.has(person.id)) continue;
        await update.run(
          JSON.stringify({ ...person, parents: undefined, spouses: undefined }),
          person.id,
        );
      }
      if (mediaChanged) await releaseAttachedMediaGrants(db);
      if (mediaChanged)
        await enforcePostgresMediaQuota(db, mediaBytesBefore, measuredAt);
      await db
        .prepare(
          "INSERT INTO history(revision,data) VALUES(?,?)",
          "INSERT INTO history(revision,data) VALUES(?,?)",
        )
        .run(
          revision,
          JSON.stringify({
            format: "drevo-person-patches-v1",
            changes: inverseChanges(appliedChanges),
          }),
        );
      await auditStore(db).archive(before, after, actor, revision + 1);
      await db
        .prepare(
          "UPDATE archive SET revision=? WHERE id=1",
          "UPDATE archives SET revision=? WHERE id=current_setting('drevo.archive_id', true)",
        )
        .run(revision + 1);
      await db.exec(
        "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50)",
        "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50)",
      );
    }

    return {
      revision: revision + Number(appliedChanges.length > 0),
      baseRevision: revision,
      appliedChanges,
    };
  };
  // A trusted caller may add its own checks and metadata in the same archive
  // transaction. The normal HTTP path still owns the transaction here.
  if (options.withinTransaction) {
    if (!db.inTransaction()) throw new Error("Ожидается транзакция архива");
    return await apply();
  }
  return await db.transaction(apply);
}
