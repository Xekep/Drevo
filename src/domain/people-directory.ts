import { fullName, matchesPerson } from "./dates.ts";
import type { Person } from "./types.ts";
export type PeopleSort =
  "name" | "name-desc" | "birth" | "birth-desc" | "death";
export function directoryPeople(
  people: Person[],
  query: string,
  sort: PeopleSort,
) {
  return people
    .filter((p) => matchesPerson(p, query))
    .sort((a, b) => {
      if (sort === "birth" || sort === "birth-desc" || sort === "death") {
        const x = sort === "death" ? a.death : a.birth,
          y = sort === "death" ? b.death : b.birth;
        if (!!x !== !!y) return x ? -1 : 1;
        if (x && y && x !== y)
          return x.localeCompare(y) * (sort === "birth-desc" ? -1 : 1);
      }
      return (
        fullName(a).localeCompare(fullName(b), "ru", {
          sensitivity: "base",
          numeric: true,
        }) * (sort === "name-desc" ? -1 : 1) || a.id.localeCompare(b.id)
      );
    });
}
/** Отсутствие даты смерти не означает, что человек жив сейчас. */
export function directoryYears(p: Person) {
  const birth = p.birth?.slice(0, 4),
    death = p.death?.slice(0, 4);
  return birth && death
    ? `${birth} — ${death}`
    : birth
      ? `Род. ${birth}`
      : death
        ? `Ум. ${death}`
        : "";
}
