import type { TreeGeometry, LayoutPerson } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { routeKey, routeRelationships, simplifyRoute } from "./edge-routing.ts";
import type { placedFamilyRows } from "./local-family-order.ts";

export type FamilyRowQuality = {
  crossings: number;
  contacts: number;
  length: number;
  bends: number;
  cardHits: number;
  overlaps: number;
};
export type FamilyRowScore = (geometry: TreeGeometry) => FamilyRowQuality;
export type FamilyRowBlock = ReturnType<
  typeof placedFamilyRows
>[number][number];
export type FamilyRowMove = {
  geometry: TreeGeometry;
  moved: Set<string>;
  distance: number;
};
export const FAMILY_ROW_GAP = 64;

/** Translate complete households; identity, spouse order and generation Y stay fixed. */
export function translateFamilyBlocks(
  geometry: TreeGeometry,
  deltas: Map<string, number>,
): FamilyRowMove {
  const members = new Map(
    (geometry.occurrences || []).map((o) => [o.id, o.block]),
  );
  const shifted = new Map(
    geometry.positions.map(([id]) => [id, deltas.get(members.get(id)!) || 0]),
  );
  const moved = new Set(
    [...shifted].filter(([, delta]) => delta).map(([id]) => id),
  );
  const positions: TreeGeometry["positions"] = geometry.positions.map(
    ([id, point]) => [
      id,
      shifted.get(id) ? { ...point, x: point.x + shifted.get(id)! } : point,
    ],
  );
  const branches = geometry.branches?.map((branch) => {
    const source = shifted.get(branch.source) || 0,
      target = shifted.get(branch.target) || 0;
    if (!source && !target) return branch;
    const old = branch.route.points;
    if (branch.id.startsWith("pair:"))
      return {
        ...branch,
        route: {
          ...branch.route,
          points: old.map((point) => ({ ...point, x: point.x + source })),
        },
      };
    const first = { ...old[0], x: old[0].x + source };
    const last = { ...old.at(-1)!, x: old.at(-1)!.x + target };
    const y = old.length >= 4 ? old[1].y : (first.y + last.y) / 2;
    return {
      ...branch,
      route: {
        ...branch.route,
        points: simplifyRoute([
          first,
          { x: first.x, y },
          { x: last.x, y },
          last,
        ]),
      },
    };
  });
  return {
    geometry: {
      ...geometry,
      positions,
      branches,
      blocks: geometry.blocks?.map((block) =>
        deltas.get(block.id)
          ? { ...block, x: block.x + deltas.get(block.id)! }
          : block,
      ),
    },
    moved,
    distance:
      [...shifted.values()].reduce((sum, delta) => sum + Math.abs(delta), 0) /
      Math.max(1, shifted.size),
  };
}

export function reorderFamilyRow(
  geometry: TreeGeometry,
  row: FamilyRowBlock[],
  from: number,
  to: number,
) {
  if (
    row.some((block, i) => i > 0 && block.x < row[i - 1].x + row[i - 1].width)
  )
    return;
  const order = [...row];
  order.splice(to, 0, ...order.splice(from, 1));
  const gaps = row
    .slice(1)
    .map((block, i) => block.x - row[i].x - row[i].width);
  let x = row[0].x;
  const deltas = new Map<string, number>();
  order.forEach((block, i) => {
    deltas.set(block.id, x - block.x);
    x += block.width + (gaps[i] || 0);
  });
  return translateFamilyBlocks(geometry, deltas);
}

/** Recompute moved endpoints against current obstacles instead of stretching old channels. */
export function routeFamilyMove(
  move: FamilyRowMove,
  size: TreeNodeSize,
  preserved = new Set<string>(),
): TreeGeometry {
  const geometry = move.geometry,
    positions = geometry.positions;
  const known = new Set(positions.map(([id]) => id));
  let jointId = "routing-row-joint";
  while (known.has(jointId)) jointId += ":";
  const people: LayoutPerson[] = positions.map(([id]) => ({
    id,
    birth: "",
    parents: [],
    spouses: [],
  }));
  let branches = [...(geometry.branches || [])];
  const searchBudget = { remaining: 4 };
  for (const branch of branches.filter(
    (b) =>
      b.id.startsWith("child:") &&
      !preserved.has(b.id) &&
      (move.moved.has(b.source) || move.moved.has(b.target)),
  )) {
    const start = branch.route.points[0],
      direction = branch.route.sourceHandle === "bottom" ? 1 : -1;
    const route = routeRelationships(
      [
        ...people.map((p) =>
          p.id === branch.target ? { ...p, parents: [jointId] } : p,
        ),
        { id: jointId, birth: "", parents: [], spouses: [] },
      ],
      [],
      [...positions, [jointId, { x: start.x, y: start.y + 10 * direction }]],
      size.width,
      size.height,
      new Set([jointId]),
      branches
        .filter((b) => b.id !== branch.id)
        .map((b) => ({ group: b.union, route: b.route })),
      new Map([
        [
          routeKey({ type: "parent", from: jointId, to: branch.target }),
          {
            group: branch.union,
            sourceHandle: branch.route.sourceHandle,
            targetHandle: branch.route.targetHandle,
            searchBudget,
          },
        ],
      ]),
    )[0]?.[1];
    if (route)
      branches = branches.map((b) =>
        b.id === branch.id
          ? {
              ...b,
              route: {
                ...route,
                points: simplifyRoute([start, ...route.points]),
              },
            }
          : b,
      );
  }
  return { ...geometry, branches };
}

export function familyRowNoWorse(
  next: FamilyRowQuality,
  before: FamilyRowQuality,
) {
  return (
    next.cardHits <= before.cardHits &&
    next.overlaps <= before.overlaps &&
    next.crossings <= before.crossings &&
    next.contacts <= before.contacts &&
    next.length <= before.length * 1.15 &&
    next.bends <= before.bends + 4
  );
}
