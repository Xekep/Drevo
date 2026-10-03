import { familyPositions } from "./family-layout.ts";
import { householdLevels } from "./household-levels.ts";
import { familyNeighbors } from "./family-neighborhood.ts";
import type { GenerationBand } from "./generation-bands.ts";
import { arrangeHouseholds } from "./family-arrangement.ts";
import { routeRelationships, type EdgeRoute } from "./edge-routing.ts";
import type { Person, Family, FamilyLink } from "./types.ts";
import type {
  UnionOccurrence,
  UnionBlock,
  UnionBranch,
} from "./union-layout.ts";
export type LayoutPerson = Pick<Person, "id" | "birth" | "parents" | "spouses">;
import { dateYear } from "./dates.ts";
import { yearY, START_YEAR } from "./layout.ts";
import {
  type TreeNodeSize,
  TREE_NODE_HEIGHT,
  TREE_NODE_WIDTH,
} from "./tree-layout-constants.ts";

export { TREE_NODE_HEIGHT, TREE_NODE_WIDTH } from "./tree-layout-constants.ts";
export type TreeMode = "generations" | "timeline";
export type TreeGeometry = {
  nodeSize?: TreeNodeSize;
  mode: TreeMode;
  reverse: boolean;
  positions: [string, { x: number; y: number }][];
  start: number;
  offset: number;
  routes?: [string, EdgeRoute][];
  occurrences?: UnionOccurrence[];
  blocks?: UnionBlock[];
  siblingGroups?: UnionBlock[];
  generationBands?: GenerationBand[];
  branches?: UnionBranch[];
  coveredRelations?: string[];
};
/** Линейный обход DAG; не зависит от хранимого служебного generation. */
export function generationLevels(people: LayoutPerson[]) {
  return householdLevels(people);
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
    if (link.type === "adoptive_parent" || link.type === "foster_parent") {
      const parents = adoptive.get(link.to) || [];
      parents.push(link.from);
      adoptive.set(link.to, parents);
    }
  const parentage = people.map((p) => ({
    ...p,
    parents: [...new Set([...p.parents, ...(adoptive.get(p.id) || [])])],
  }));
  const peopleMap = new Map(parentage.map((p) => [p.id, p]));
  const levels = householdLevels(parentage),
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
    const familyX = new Map(placed.map(([id, p]) => [id, p.x]));
    let active: { x: number; bottom: number }[] = [];
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
      active = active.filter((point) => point.bottom + 20 > y);
      const desired = familyX.get(p.id) || 0;
      const gap = TREE_NODE_WIDTH + 32;
      let left = desired,
        right = desired;
      for (const point of active) {
        if (point.x - right >= gap) break;
        if (Math.abs(point.x - right) < gap) right = point.x + gap;
      }
      for (let i = active.length - 1; i >= 0; i--) {
        if (left - active[i].x >= gap) break;
        if (Math.abs(active[i].x - left) < gap) left = active[i].x - gap;
      }
      const x = desired - left <= right - desired ? left : right;
      const index = active.findIndex((point) => point.x > x);
      active.splice(index < 0 ? active.length : index, 0, {
        x,
        bottom: y + TREE_NODE_HEIGHT,
      });
      positions.push([p.id, { x, y }]);
    }
  }
  if (mode === "generations") {
    const arranged = arrangeHouseholds(
      people,
      links,
      positions,
      TREE_NODE_WIDTH,
      TREE_NODE_HEIGHT,
    );
    return {
      positions: arranged.positions,
      routes: arranged.routes,
      start,
      offset,
      mode,
      reverse,
    };
  }
  const routes = routeRelationships(
    people,
    links,
    positions,
    TREE_NODE_WIDTH,
    TREE_NODE_HEIGHT,
  );
  return { positions, start, offset, mode, reverse, routes };
}
export function visibleBranch(
  family: Family,
  root: string | null,
  collapsed: Set<string>,
  protectedIds: string[] = [],
) {
  const { children, people: map, neighbors } = familyNeighbors(family);
  const reachable = (
    starts: string[],
    next: (id: string) => Iterable<string>,
    within?: ReadonlySet<string>,
  ) => {
    const seen = new Set(starts.filter((id) => !within || within.has(id))),
      queue = [...seen];
    for (let i = 0; i < queue.length; i++)
      for (const id of next(queue[i]))
        if ((!within || within.has(id)) && !seen.has(id)) {
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
  const beforeCollapse = new Set(visible);
  const descendants = reachable(
    [...collapsed].flatMap((id) => [...(children.get(id) || [])]),
    (id) => children.get(id) || [],
  );
  const adjacent = (id: string) => neighbors.get(id) || [];
  const boundaries = [...collapsed].filter(
    (id) => map.has(id) && !descendants.has(id),
  );
  const affected = reachable(boundaries, adjacent, beforeCollapse);
  // При циклических архивных записях оставляем границу в каждой затронутой
  // компоненте. В обычном DAG внутренние сворачивания остаются скрытыми.
  for (const id of [...collapsed].reverse())
    if (map.has(id) && beforeCollapse.has(id) && !affected.has(id)) {
      boundaries.push(id);
      for (const connected of reachable([id], adjacent, beforeCollapse))
        affected.add(connected);
    }
  for (const descendant of descendants) visible.delete(descendant);
  for (const id of [...boundaries, ...protectedIds])
    if (map.has(id)) visible.add(id);
  if (collapsed.size) {
    // Убираем лишь фрагменты, отсоединённые сворачиванием. Изначально
    // отдельные семьи и явно выбранные карточки остаются в полном обзоре.
    const retained = reachable(
      [...boundaries, ...protectedIds],
      adjacent,
      visible,
    );
    for (const id of visible)
      if (affected.has(id) && !retained.has(id)) visible.delete(id);
  }
  return visible;
}
