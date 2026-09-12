import type { Family, Person } from "./types.ts";
import { removeConnections } from "./mutations.ts";
import type { Connection } from "./mutations.ts";

function sameValue(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Переносит только изменённые поля черновика на свежую серверную карточку. */
export function rebasePersonDraft(
  base: Person | undefined,
  fresh: Person | undefined,
  draft: Person,
): Person {
  if (!base || !fresh || base.id !== draft.id || fresh.id !== draft.id)
    return draft;
  const next = structuredClone(fresh) as Person & Record<string, unknown>;
  const old = base as Person & Record<string, unknown>;
  const edited = draft as Person & Record<string, unknown>;
  for (const key of new Set([...Object.keys(old), ...Object.keys(edited)])) {
    if (sameValue(old[key], edited[key])) continue;
    if (key in edited) next[key] = structuredClone(edited[key]);
    else delete next[key];
  }
  return next;
}

/** Person fields and staged relation removals form one archive change. */
export function applyPersonDraft(
  family: Family,
  person: Person,
  removed: Connection[],
): Family {
  const exists = family.people.some((p) => p.id === person.id);
  const next = {
    ...family,
    people: exists
      ? family.people.map((p) => (p.id === person.id ? person : p))
      : [...family.people, person],
  };
  return removed.length ? removeConnections(next, removed) : next;
}
