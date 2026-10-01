import type { familyNeighbors } from "./family-neighborhood.ts";
import type { TreeGenerationLimits } from "./tree-preferences.ts";

/** A bounded projection of recorded genealogy, independent of card coordinates. */
export function generationScope(
  index: ReturnType<typeof familyNeighbors>,
  limits: TreeGenerationLimits,
): Set<string> {
  const { people, children } = index;
  // A deleted/missing anchor must not make the archive appear empty.
  if (!people.has(limits.anchorId)) return new Set(people.keys());
  const upper = limits.ancestors === 7 ? Infinity : limits.ancestors;
  const levels = new Map<string, number>([[limits.anchorId, 0]]);
  const ancestors = [{ id: limits.anchorId, depth: 0 }];
  for (let i = 0; i < ancestors.length; i++) {
    const { id, depth } = ancestors[i];
    if (depth >= upper) continue;
    for (const parent of people.get(id)!.parents) {
      if (!people.has(parent) || levels.has(parent)) continue;
      levels.set(parent, -depth - 1);
      ancestors.push({ id: parent, depth: depth + 1 });
    }
  }
  const descendants = [{ id: limits.anchorId, depth: 0 }];
  const visited = new Set([limits.anchorId]);
  for (let i = 0; i < descendants.length; i++) {
    const { id, depth } = descendants[i];
    if (depth >= limits.descendants) continue;
    for (const child of children.get(id) || []) {
      if (visited.has(child)) continue;
      visited.add(child);
      if (!levels.has(child)) levels.set(child, depth + 1);
      descendants.push({ id: child, depth: depth + 1 });
    }
  }
  const visible = new Set(levels.keys());
  // One generation off the direct lines includes siblings/uncles/aunts;
  // two also includes their children (nieces, nephews, cousins).
  const side = [...levels].map(([id, level]) => ({ id, level, depth: 0 }));
  const sideDepth = new Map<string, number>();
  for (let i = 0; i < side.length; i++) {
    const { id, level, depth } = side[i];
    if (depth >= limits.collateral || level >= limits.descendants) continue;
    for (const child of children.get(id) || []) {
      if (levels.has(child) || (sideDepth.get(child) ?? Infinity) <= depth + 1)
        continue;
      sideDepth.set(child, depth + 1);
      visible.add(child);
      side.push({ id: child, level: level + 1, depth: depth + 1 });
    }
  }
  // Preserve exact co-parents for visible parent-child connections. Do not
  // follow partners' ancestors or recursively open partners of partners.
  for (const id of [...visible]) {
    const parents = people.get(id)!.parents;
    if (parents.some((parent) => visible.has(parent)))
      for (const parent of parents) if (people.has(parent)) visible.add(parent);
  }
  const core = new Set(visible);
  for (const person of people.values()) {
    if (core.has(person.id)) {
      for (const spouse of person.spouses)
        if (people.has(spouse)) visible.add(spouse);
    } else if (person.spouses.some((id) => core.has(id)))
      visible.add(person.id);
  }
  return visible;
}
