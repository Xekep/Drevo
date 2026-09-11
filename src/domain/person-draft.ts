import type { Family, Person } from "./types.ts";
import { removeConnections } from "./mutations.ts";
import type { Connection } from "./mutations.ts";

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
