import { fullName, years } from "./dates.ts";
import type { Person } from "./types.ts";
export type PersonOption = { id: string; label: string; detail: string };
const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
export function findPeople(people: Person[], query: string) {
  return createPeopleSearch(people)(query);
}

/** Normalize and sort once for each archive revision, not on every keystroke. */
export function createPeopleSearch(people: Person[]) {
  const entries = people
    .map((person) => ({
      person,
      label: fullName(person),
      name: normalize(fullName(person)),
      text: normalize(
        `${fullName(person)} ${person.maidenName || ""} ${years(person)}`,
      ),
    }))
    .sort(
      (a, b) =>
        a.label.localeCompare(b.label, "ru") ||
        a.person.birth.localeCompare(b.person.birth) ||
        a.person.id.localeCompare(b.person.id),
    );
  return (query: string, visible?: ReadonlySet<string>) => {
    const needle = normalize(query);
    if (needle.length < 2)
      return { people: [] as PersonOption[], hasMore: false };
    const tokens = needle.split(/\s+/);
    const found: Person[] = [];
    for (const prefix of [true, false]) {
      for (const entry of entries) {
        if (visible && !visible.has(entry.person.id)) continue;
        if (
          entry.name.startsWith(needle) !== prefix ||
          !tokens.every((token) => entry.text.includes(token))
        )
          continue;
        found.push(entry.person);
        if (found.length > 20) break;
      }
      if (found.length > 20) break;
    }
    return {
      people: found.slice(0, 20).map((p) => ({
        id: p.id,
        label: fullName(p),
        detail: [years(p), p.maidenName ? `при рождении: ${p.maidenName}` : ""]
          .filter(Boolean)
          .join(" · "),
      })),
      hasMore: found.length > 20,
    };
  };
}
