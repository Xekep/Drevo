import { fullName, years } from "./dates.ts";
import type { Person } from "./types.ts";
export type PersonOption = { id: string; label: string; detail: string };
const normalize = (value: string) =>
  value.normalize("NFKC").toLocaleLowerCase("ru").replaceAll("ё", "е").trim();
export function findPeople(people: Person[], query: string) {
  const needle = normalize(query);
  if (needle.length < 2)
    return { people: [] as PersonOption[], hasMore: false };
  const tokens = needle.split(/\s+/);
  const found = people
    .filter((person) => {
      const text = normalize(
        `${fullName(person)} ${person.maidenName || ""} ${years(person)}`,
      );
      return tokens.every((token) => text.includes(token));
    })
    .sort(
      (a, b) =>
        Number(normalize(fullName(b)).startsWith(needle)) -
          Number(normalize(fullName(a)).startsWith(needle)) ||
        fullName(a).localeCompare(fullName(b), "ru") ||
        a.birth.localeCompare(b.birth) ||
        a.id.localeCompare(b.id),
    );
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
}
