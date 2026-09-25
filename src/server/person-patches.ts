import type { DatabaseSync } from "node:sqlite";
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
import { ForbiddenError } from "./users.ts";
import { auditStore } from "./audit.ts";

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
  "photo",
  "sources",
  "awards",
  "events",
  "parentageComplete",
  "generation",
  "column",
]);

/** Existing card fields only. Structural changes retain whole-graph validation. */
export function patchPeople(
  db: DatabaseSync,
  changes: Change[],
  expected: number,
  actor: ArchiveUser,
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
  db.exec("BEGIN IMMEDIATE");
  try {
    const revision = Number(
      db.prepare("SELECT revision FROM archive WHERE id=1").get()!.revision,
    );
    if (expected > revision)
      throw new ConflictError("Некорректная версия архива");
    const selected = new Set(ids),
      related = new Set(ids);
    const placeholders = ids.map(() => "?").join(",");
    const relations = db
      .prepare(
        `SELECT * FROM relations WHERE source IN (${placeholders}) OR target IN (${placeholders})`,
      )
      .all(...ids, ...ids);
    for (const row of relations) {
      related.add(String(row.source));
      related.add(String(row.target));
    }
    const people = [...related].map((id) => {
      const row = db.prepare("SELECT data FROM people WHERE id=?").get(id);
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
      const update = db.prepare("UPDATE people SET data=? WHERE id=?");
      for (const person of after.people) {
        if (!selected.has(person.id)) continue;
        update.run(
          JSON.stringify({ ...person, parents: undefined, spouses: undefined }),
          person.id,
        );
      }
      db.prepare("INSERT INTO history(revision,data) VALUES(?,?)").run(
        revision,
        JSON.stringify({
          format: "drevo-person-patches-v1",
          changes: inverseChanges(appliedChanges),
        }),
      );
      auditStore(db).archive(before, after, actor, revision + 1);
      db.prepare("UPDATE archive SET revision=? WHERE id=1").run(revision + 1);
      db.exec(
        "DELETE FROM history WHERE revision NOT IN (SELECT revision FROM history ORDER BY revision DESC LIMIT 50)",
      );
    }
    db.exec("COMMIT");
    return {
      revision: revision + Number(appliedChanges.length > 0),
      baseRevision: revision,
      appliedChanges,
    };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
