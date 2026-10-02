import { fullName } from "./dates.ts";
import { familyNeighbors } from "./family-neighborhood.ts";
import { repositorySummary } from "./person-sources.ts";
import type { Family } from "./types.ts";

export type LineageDirection = "ancestors" | "descendants";

/** A reproducible report based solely on recorded facts in the visible family. */
export function lineageReport(
  family: Pick<Family, "people">,
  rootId: string,
  direction: LineageDirection,
  generations: number,
) {
  const index = familyNeighbors(family);
  const root = index.people.get(rootId);
  if (!root) throw new Error("Выберите человека для росписи.");
  const limit = Math.max(1, Math.min(20, Math.floor(generations)));
  const byGeneration = new Map<number, string[]>();
  const queue: Array<{ id: string; depth: number }> = [
    { id: rootId, depth: 0 },
  ];
  const visited = new Set<string>();
  for (let position = 0; position < queue.length; position++) {
    const { id, depth } = queue[position];
    if (visited.has(id)) continue;
    visited.add(id);
    const group = byGeneration.get(depth) || [];
    group.push(id);
    byGeneration.set(depth, group);
    if (depth + 1 >= limit) continue;
    const next =
      direction === "ancestors"
        ? index.people.get(id)?.parents || []
        : [...(index.children.get(id) || [])];
    for (const relative of next)
      if (index.people.has(relative) && !visited.has(relative))
        queue.push({ id: relative, depth: depth + 1 });
  }

  const lines = [
    `${direction === "ancestors" ? "Роспись предков" : "Роспись потомков"}: ${fullName(root)}`,
    `Поколений: ${byGeneration.size}. Людей: ${visited.size}.`,
    "Составлено по записанным сведениям семейного архива.",
  ];
  for (const [depth, ids] of byGeneration) {
    lines.push("", `Поколение ${depth + 1}`);
    for (const [position, id] of ids.entries()) {
      const person = index.people.get(id)!;
      const life = [person.birth, person.death].filter(Boolean).join(" — ");
      lines.push(
        `${position + 1}. ${fullName(person)}${life ? ` (${life})` : ""}`,
      );
      if (person.birthPlace)
        lines.push(`   Место рождения: ${person.birthPlace}`);
      if (person.deathPlace)
        lines.push(`   Место смерти: ${person.deathPlace}`);
      const parents = person.parents
        .filter((parentId) => index.people.has(parentId))
        .map((parentId) => fullName(index.people.get(parentId)!));
      if (parents.length) lines.push(`   Родители: ${parents.join(", ")}`);
      for (const source of person.sources)
        lines.push(
          `   Источник: ${[source.title, source.reference, repositorySummary(source), source.url]
            .filter(Boolean)
            .join(" · ")}`,
        );
    }
  }
  return lines.join("\n") + "\n";
}
