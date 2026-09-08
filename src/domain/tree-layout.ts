import { familyPositions } from "./family-layout.ts";
import type { Person, Family, FamilyLink } from "./types.ts";
export type LayoutPerson = Pick<Person, "id" | "birth" | "parents" | "spouses">;
import { dateYear } from "./dates.ts";
import { yearY, START_YEAR } from "./layout.ts";

export const TREE_NODE_WIDTH = 220,
  TREE_NODE_HEIGHT = 96;
export type TreeMode = "generations" | "timeline";
export type TreeGeometry = {
  mode: TreeMode;
  reverse: boolean;
  positions: [string, { x: number; y: number }][];
  start: number;
  offset: number;
};
/** Линейный обход DAG; не зависит от хранимого служебного generation. */
export function generationLevels(people: LayoutPerson[]) {
  const levels = new Map<string, number>(),
    incoming = new Map<string, number>(),
    children = new Map<string, string[]>();
  const ids = new Set(people.map((p) => p.id));
  for (const p of people) {
    const parents = p.parents.filter((id) => ids.has(id));
    incoming.set(p.id, parents.length);
    for (const id of parents) {
      const list = children.get(id) || [];
      list.push(p.id);
      children.set(id, list);
    }
  }
  const queue = people.filter((p) => !incoming.get(p.id)).map((p) => p.id);
  const processed = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i],
      level = levels.get(id) || 0;
    levels.set(id, level);
    processed.add(id);
    for (const child of children.get(id) || []) {
      levels.set(child, Math.max(levels.get(child) || 0, level + 1));
      incoming.set(child, incoming.get(child)! - 1);
      if (!incoming.get(child)) queue.push(child);
    }
  }
  return new Map([...levels].filter(([id]) => processed.has(id)));
}
export function treeGeometry(
  people: LayoutPerson[],
  mode: TreeMode,
  reverse = false,
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
): TreeGeometry {
  const start = Math.min(
    START_YEAR,
    ...people
      .filter((p) => p.birth)
      .map((p) => Math.floor(dateYear(p.birth) / 10) * 10),
  );
  const adoptive = new Map<string, string[]>();
  for (const link of links)
    if (link.type === "adoptive_parent") {
      const parents = adoptive.get(link.to) || [];
      parents.push(link.from);
      adoptive.set(link.to, parents);
    }
  const parentage = people.map((p) => ({
    ...p,
    parents: [...new Set([...p.parents, ...(adoptive.get(p.id) || [])])],
  }));
  const peopleMap = new Map(parentage.map((p) => [p.id, p]));
  // Ограничение раскладки: супруг без известных родителей следует уровню партнёра.
  const aligned = parentage.map((p) => ({
    ...p,
    parents: p.parents.length
      ? p.parents
      : p.spouses.map((id) => peopleMap.get(id)).find((s) => s?.parents.length)
          ?.parents || [],
  }));
  const alignedLevels = generationLevels(aligned);
  const levels =
      alignedLevels.size === people.length
        ? alignedLevels
        : generationLevels(parentage),
    placed = familyPositions(
      parentage,
      levels,
      TREE_NODE_WIDTH,
      TREE_NODE_HEIGHT,
    );
  const positions: TreeGeometry["positions"] =
    mode === "timeline"
      ? placed.filter(([id]) => !peopleMap.get(id)?.birth)
      : placed;
  const height = Math.max(0, ...positions.map(([, p]) => p.y));
  if (reverse) for (const [, point] of positions) point.y = height - point.y;
  const offset =
    mode === "timeline" && positions.length
      ? height + TREE_NODE_HEIGHT + 100
      : 0;
  if (mode === "timeline") {
    const bottoms: number[] = [];
    const dated = people
      .filter((p) => p.birth)
      .sort(
        (a, b) =>
          yearY(dateYear(a.birth), start, reverse) -
            yearY(dateYear(b.birth), start, reverse) ||
          a.id.localeCompare(b.id),
      );
    for (const p of dated) {
      const y = offset + yearY(dateYear(p.birth), start, reverse);
      let column = bottoms.findIndex((bottom) => bottom + 20 <= y);
      if (column < 0) column = bottoms.length;
      bottoms[column] = y + TREE_NODE_HEIGHT;
      positions.push([p.id, { x: column * 268, y }]);
    }
  }
  return { positions, start, offset, mode, reverse };
}
export function visibleBranch(
  family: Family,
  root: string | null,
  collapsed: Set<string>,
  protectedIds: string[] = [],
) {
  const children = new Map<string, string[]>(),
    map = new Map(family.people.map((p) => [p.id, p]));
  for (const p of family.people)
    for (const parent of p.parents) {
      const list = children.get(parent) || [];
      list.push(p.id);
      children.set(parent, list);
    }
  const reachable = (starts: string[], neighbors: (id: string) => string[]) => {
    const seen = new Set(starts),
      queue = [...starts];
    for (let i = 0; i < queue.length; i++)
      for (const id of neighbors(queue[i]))
        if (!seen.has(id)) {
          seen.add(id);
          queue.push(id);
        }
    return seen;
  };
  let visible = new Set(family.people.map((p) => p.id));
  if (root && map.has(root)) {
    visible = reachable([root], (id) => map.get(id)?.parents || []);
    for (const id of reachable([root], (id) => children.get(id) || []))
      visible.add(id);
    for (const id of [...visible])
      for (const spouse of map.get(id)?.spouses || []) visible.add(spouse);
  }
  for (const id of collapsed)
    for (const descendant of reachable(
      children.get(id) || [],
      (p) => children.get(p) || [],
    ))
      visible.delete(descendant);
  for (const id of [...collapsed, ...protectedIds])
    if (map.has(id)) visible.add(id);
  return visible;
}
