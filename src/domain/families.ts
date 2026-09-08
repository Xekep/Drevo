import type { Person } from "./types.ts";
export type FamilyGroup = { id: string; parents: Person[]; children: Person[] };
export function familyGroups(people: Person[]): FamilyGroup[] {
  const map = new Map(people.map((p) => [p.id, p])),
    groups = new Map<string, FamilyGroup>();
  const group = (ids: string[]) => {
    const parents = [...new Set(ids)].filter((id) => map.has(id)).sort(),
      key = JSON.stringify(parents);
    if (!groups.has(key))
      groups.set(key, {
        id: key,
        parents: parents.map((id) => map.get(id)!),
        children: [],
      });
    return groups.get(key)!;
  };
  for (const p of people) {
    if (p.parents.length) group(p.parents).children.push(p);
    for (const id of p.spouses) if (map.has(id)) group([p.id, id]);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      children: g.children.sort((a, b) =>
        (a.birth || "9999").localeCompare(b.birth || "9999"),
      ),
    }))
    .sort(
      (a, b) =>
        a.parents[0].surname.localeCompare(b.parents[0].surname, "ru") ||
        a.parents[0].birth.localeCompare(b.parents[0].birth),
    );
}
