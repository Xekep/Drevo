import type { Family } from "./types.ts";
import {
  bloodRelativesWithPartners,
  completeVisibleParents,
  familyNeighborhood,
  familyNeighbors,
} from "./family-neighborhood.ts";

export type TreeExportScope =
  "current" | "all" | "family" | "ancestors" | "descendants" | "blood";

/** Select only people already present in the caller's authorized family view. */
export function treeExportPeople(
  family: Pick<Family, "people" | "links" | "unions">,
  scope: Exclude<TreeExportScope, "current">,
  anchorId?: string,
  generations = 5,
) {
  const index = familyNeighbors(family);
  if (scope === "all") return new Set(index.people.keys());
  if (!anchorId || !index.people.has(anchorId)) return new Set<string>();
  if (scope === "family") return familyNeighborhood(index, anchorId).visible;
  if (scope === "blood") return bloodRelativesWithPartners(index, anchorId, family.unions);

  const selected = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [
    { id: anchorId, depth: 0 },
  ];
  for (let position = 0; position < queue.length; position++) {
    const { id, depth } = queue[position];
    if (selected.has(id)) continue;
    selected.add(id);
    if (depth + 1 >= generations) continue;
    const relatives =
      scope === "ancestors"
        ? index.people.get(id)?.parents || []
        : [...(index.children.get(id) || [])];
    for (const relative of relatives)
      if (index.people.has(relative) && !selected.has(relative))
        queue.push({ id: relative, depth: depth + 1 });
  }
  return completeVisibleParents(index, selected);
}
