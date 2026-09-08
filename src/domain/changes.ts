import type { Family } from "./types.ts";
import { validateFamily } from "./validation.ts";

export type Change = {
  collection: "people" | "links" | "photos" | "meta";
  id?: string;
  field?: string;
  before: unknown;
  after: unknown;
};
export type ChangeConflict = { change: Change; current: unknown };
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => sameValue(v, b[i]))
    );
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])];
  return keys.every((k) => sameValue(x[k], y[k]));
}
/** Поля изменяются отдельно: отмена биографии не затрагивает чужую дату рождения. */
export function archiveChanges(before: Family, after: Family): Change[] {
  const result: Change[] = [];
  for (const field of ["title", "description", "demo"] as const) {
    if (!sameValue(before[field], after[field]))
      result.push({
        collection: "meta",
        field,
        before: before[field],
        after: after[field],
      });
  }
  for (const collection of ["people", "links", "photos"] as const) {
    const a = new Map(
      (before[collection] || []).map((p) => [p.id, p] as const),
    );
    const b = new Map((after[collection] || []).map((p) => [p.id, p] as const));
    for (const id of new Set([...a.keys(), ...b.keys()])) {
      const old = a.get(id),
        next = b.get(id);
      if (!old || !next) {
        result.push({ collection, id, before: old, after: next });
        continue;
      }
      const x = old as unknown as Record<string, unknown>,
        y = next as unknown as Record<string, unknown>;
      for (const field of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (!sameValue(x[field], y[field]))
          result.push({
            collection,
            id,
            field,
            before: x[field],
            after: y[field],
          });
      }
    }
  }
  return structuredClone(result);
}
export const inverseChanges = (changes: Change[]) =>
  changes.map((c) => ({ ...c, before: c.after, after: c.before }));
export function applyArchiveChanges(
  current: Family,
  changes: Change[],
  prefer: "local" | "remote" = "remote",
) {
  const next = structuredClone(current),
    conflicts: ChangeConflict[] = [];
  for (const change of changes) {
    const { collection, id, field, before, after } = change;
    const items =
      collection === "meta"
        ? []
        : ((next[collection] ||= []) as unknown as Record<string, unknown>[]);
    const index = items.findIndex((p) => p.id === id);
    const item =
      collection === "meta"
        ? (next as unknown as Record<string, unknown>)
        : items[index];
    const value = field ? item?.[field] : item;
    if (sameValue(value, after)) continue;
    if (!sameValue(value, before) || (field && !item)) {
      conflicts.push({ change, current: value });
      if (prefer !== "local") continue;
    }
    if (field) {
      if (!item)
        throw new Error(
          "Карточка удалена другим участником. Черновик сохранён, но восстановить только одно поле нельзя.",
        );
      if (after === undefined) delete item[field];
      else item[field] = structuredClone(after);
    } else if (after === undefined) {
      if (index >= 0) items.splice(index, 1);
    } else if (index >= 0)
      items[index] = structuredClone(after) as Record<string, unknown>;
    else items.push(structuredClone(after) as Record<string, unknown>);
  }
  return { family: next, conflicts };
}
export function validatedChanges(
  current: Family,
  changes: Change[],
  prefer: "local" | "remote" = "remote",
) {
  const result = applyArchiveChanges(current, changes, prefer);
  return { ...result, family: validateFamily(result.family) };
}
