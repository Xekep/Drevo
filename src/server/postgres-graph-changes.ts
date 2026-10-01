import { isDeepStrictEqual } from "node:util";
import type pg from "pg";
import type { ArchiveUser } from "../domain/access.ts";
import {
  applyArchiveChanges,
  archiveChanges,
  type Change,
} from "../domain/changes.ts";
import type { Family } from "../domain/types.ts";
import { ConflictError } from "./archive-errors.ts";
import { persistPostgresGraphChanges } from "./postgres-graph-rows.ts";
import { authorizeArchive } from "./permissions.ts";
import { readPostgresArchiveInTransaction } from "./postgres-archive-read.ts";
import {
  withPostgresArchiveWrite,
  rememberPostgresArchiveChange,
} from "./postgres-archive-write.ts";
import { checkPostgresPeopleGrowth } from "./postgres-people-quota.ts";
import { ForbiddenError } from "./users.ts";

const personFields = new Set([
  "parents",
  "spouses",
  "generation",
  "parentageComplete",
]);
const linkFields = new Set(["from", "to", "type", "note", "twinKind"]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function validateGraphChanges(input: Change[]): Change[] {
  if (!Array.isArray(input) || !input.length || input.length > 10_000)
    throw new Error("Ожидается пакет изменений людей и связей");
  for (const change of input) {
    if (
      !change ||
      typeof change.id !== "string" ||
      !change.id ||
      change.id.length > 200
    )
      throw new Error("Некорректный ID изменения");
    if (change.collection === "people") {
      if (change.field !== undefined) {
        if (!personFields.has(change.field))
          throw new Error(
            "Эта операция изменяет только связи существующих людей",
          );
      } else if (
        change.before !== undefined ||
        !record(change.after) ||
        change.after.id !== change.id ||
        (change.after.photo !== undefined && change.after.photo !== "")
      ) {
        throw new Error("Допустимо только добавление человека без портрета");
      }
    } else if (change.collection === "links") {
      if (change.field !== undefined) {
        if (!linkFields.has(change.field))
          throw new Error("Некорректное поле связи");
      } else {
        if (change.before === undefined && change.after === undefined)
          throw new Error("Не указана связь");
        for (const value of [change.before, change.after])
          if (value !== undefined && (!record(value) || value.id !== change.id))
            throw new Error("Некорректная связь");
        if (
          record(change.after) &&
          Object.keys(change.after).some(
            (key) =>
              !["id", "createdBy", "from", "to", "type", "note", "twinKind"].includes(key),
          )
        )
          throw new Error("Неизвестное поле связи");
      }
    } else throw new Error("Эта операция изменяет только людей и связи");
  }
  if (
    input.filter((change) => change.collection === "people" && !change.field)
      .length > 500
  )
    throw new Error("Слишком много новых карточек в одном запросе");
  return structuredClone(input);
}

function prepareChanges(changes: Change[], before: Family, actor: ArchiveUser) {
  const people = new Map(before.people.map((person) => [person.id, person]));
  const links = new Map((before.links || []).map((link) => [link.id, link]));
  for (const change of changes) {
    // SQL hydration omits an empty note; use that same representation in CAS.
    if (change.collection === "links") {
      if (change.field === "note") {
        if (change.before === "") change.before = undefined;
        if (change.after === "") change.after = undefined;
      } else if (change.field === undefined) {
        for (const value of [change.before, change.after])
          if (record(value) && value.note === "") delete value.note;
      }
    }
    const existing =
      change.collection === "people"
        ? people.get(change.id!)
        : links.get(change.id!);
    if (actor.role !== "admin" && existing && existing.createdBy !== actor.id)
      throw new ForbiddenError("Можно изменять только свои карточки и связи");
    if (actor.role !== "admin" && change.field && !existing)
      throw new ForbiddenError("Можно изменять только свои карточки и связи");
    // Marriage lists are sets, not a second independent ordering of the same
    // undirected SQL edge. Preserve the server order and make retries stable.
    if (
      change.collection === "people" &&
      change.field === "spouses" &&
      existing &&
      "spouses" in existing
    ) {
      const spouses = existing.spouses;
      const sameMembers = (value: unknown) =>
        Array.isArray(value) &&
        value.length === spouses.length &&
        new Set(value).size === value.length &&
        value.every((id) => spouses.includes(id));
      if (sameMembers(change.before)) change.before = [...spouses];
      if (sameMembers(change.after)) change.after = [...spouses];
    }
    if (
      change.field === undefined &&
      change.before === undefined &&
      record(change.after)
    ) {
      if (
        change.after.createdBy !== undefined &&
        change.after.createdBy !== actor.id
      )
        throw new ForbiddenError("Нельзя назначить другого автора");
      change.after.createdBy = actor.id;
      if (
        existing &&
        "spouses" in existing &&
        Array.isArray(change.after.spouses) &&
        change.after.spouses.length === existing.spouses.length &&
        new Set(change.after.spouses).size === change.after.spouses.length &&
        change.after.spouses.every((id) => existing.spouses.includes(id))
      )
        change.after.spouses = [...existing.spouses];
    }
  }
}

function validateTopology(before: Family, after: Family) {
  const previous = new Map(before.people.map((person) => [person.id, person]));
  const people = new Map(after.people.map((person) => [person.id, person]));
  for (const person of after.people) {
    if (
      !isDeepStrictEqual(person.parents, previous.get(person.id)?.parents) &&
      person.parents.length > 2
    )
      throw new Error("Укажите не более двух кровных родителей");
    for (const spouse of person.spouses)
      if (!people.get(spouse)?.spouses.includes(person.id))
        throw new Error("Брачная связь должна быть указана у обоих супругов");
  }
}

/** Atomic delta protocol used by the UI/domain, not a replacement snapshot.
 * Supports new people and edits/removal of relations, not person deletion/media.
 * HTTP remains on SQLite until the rest of the isolated write path is ready.
 */
export async function changePostgresGraphForSession(
  client: pg.Client,
  sessionToken: string,
  archiveId: string,
  input: Change[],
  expectedRevision: number,
) {
  const changes = validateGraphChanges(input);
  return withPostgresArchiveWrite(
    client,
    sessionToken,
    archiveId,
    expectedRevision,
    async (actor, revision) => {
      const before = (await readPostgresArchiveInTransaction(client, archiveId))
        .family;
      prepareChanges(changes, before, actor);
      const merged = applyArchiveChanges(before, changes);
      if (merged.conflicts.length)
        throw new ConflictError(
          "Изменяемые сведения уже обновлены другим участником",
        );
      // Match removeConnection: an omitted completeness flag must not silently
      // remain true after a parent is removed. Explicit undo may restore it.
      const oldPeople = new Map(
        before.people.map((person) => [person.id, person]),
      );
      const explicitCompleteness = new Set(
        changes
          .filter(
            (change) =>
              change.collection === "people" &&
              change.field === "parentageComplete",
          )
          .map((change) => change.id),
      );
      for (const person of merged.family.people)
        if (
          !explicitCompleteness.has(person.id) &&
          oldPeople
            .get(person.id)
            ?.parents.some((id) => !person.parents.includes(id))
        )
          person.parentageComplete = false;
      const after = authorizeArchive(merged.family, before, actor);
      validateTopology(before, after);
      if (!archiveChanges(before, after).length)
        return { revision, baseRevision: revision, appliedChanges: [] };
      await checkPostgresPeopleGrowth(
        client,
        archiveId,
        after.people.length - before.people.length,
      );
      const persisted = await persistPostgresGraphChanges(
        client,
        archiveId,
        before,
        after,
      );
      return rememberPostgresArchiveChange(
        client,
        archiveId,
        before,
        persisted,
        actor,
        revision,
        "snapshot",
      );
    },
  );
}
