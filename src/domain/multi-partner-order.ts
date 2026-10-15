import type { TreeGeometry, LayoutPerson } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import {
  routeRelationships,
  simplifyRoute,
  type EdgeRoute,
} from "./edge-routing.ts";
import {
  routeFamilyMove,
  familyRowNoWorse,
  type FamilyRowScore,
} from "./family-row-moves.ts";

/** Reverse one complete multi-partner group in its existing slots.
 * For three cards this exchanges the two partners and leaves the shared person
 * in the centre. Every recorded union retains its own joint and children.
 */
export function mirrorMultiPartnerBlock(
  geometry: TreeGeometry,
  blockId: string,
  size: TreeNodeSize,
) {
  const block = placedFamilyRows(geometry, size)
    .flat()
    .find((b) => b.id === blockId);
  if (!block || block.members.length < 3) return;
  const group = new Set(block.members),
    old = new Map(geometry.positions);
  if (new Set(block.members.map((id) => old.get(id)!.y)).size !== 1) return;
  const mirror = (x: number) => block.x * 2 + block.width - x;
  const delta = new Map(
    block.members.map((id) => [
      id,
      mirror(old.get(id)!.x + size.width) - old.get(id)!.x,
    ]),
  );
  const positions: TreeGeometry["positions"] = geometry.positions.map(
    ([id, point]) => [
      id,
      group.has(id) ? { ...point, x: point.x + delta.get(id)! } : point,
    ],
  );
  const flip = (
    handle: EdgeRoute["sourceHandle"],
  ): EdgeRoute["sourceHandle"] =>
    handle === "left" ? "right" : handle === "right" ? "left" : handle;
  const branches = geometry.branches?.map((branch) => {
    if (
      branch.id.startsWith("pair:") &&
      group.has(branch.source) &&
      group.has(branch.target)
    )
      return {
        ...branch,
        route: {
          ...branch.route,
          sourceHandle: flip(branch.route.sourceHandle),
          targetHandle: flip(branch.route.targetHandle),
          points: branch.route.points.map((p) => ({ ...p, x: mirror(p.x) })),
        },
      };
    if (
      !branch.id.startsWith("child:") ||
      (!group.has(branch.source) && !group.has(branch.target))
    )
      return branch;
    const points = branch.route.points;
    const start = {
      ...points[0],
      x: group.has(branch.source) ? mirror(points[0].x) : points[0].x,
    };
    const end = {
      ...points.at(-1)!,
      x: points.at(-1)!.x + (delta.get(branch.target) || 0),
    };
    const y = points.length >= 4 ? points[1].y : (start.y + end.y) / 2;
    return {
      ...branch,
      route: {
        ...branch.route,
        points: simplifyRoute([start, { x: start.x, y }, { x: end.x, y }, end]),
      },
    };
  });
  return routeFamilyMove(
    {
      geometry: {
        ...geometry,
        positions,
        branches,
        blocks: geometry.blocks?.map((b) =>
          b.id === blockId ? { ...b, members: [...b.members].reverse() } : b,
        ),
      },
      moved: group,
      distance: 0,
    },
    size,
  );
}

export function optimizeMultiPartnerOrder(
  original: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  score: FamilyRowScore,
) {
  let best = original;
  const initial = score(original);
  const groups = placedFamilyRows(original, size)
    .flat()
    .filter((b) => b.members.length >= 3)
    .slice(0, 16);
  for (const block of groups) {
    let candidate = mirrorMultiPartnerBlock(best, block.id, size);
    if (!candidate) continue;
    if (links.length) {
      const byId = new Map(people.map((p) => [p.id, p]));
      const entries = (candidate.occurrences || []).map((o) => ({
        id: o.id,
        birth: byId.get(o.personId)?.birth || "",
        parents: [],
        spouses: [],
      }));
      const routes = routeRelationships(
        entries,
        links,
        candidate.positions,
        size.width,
        size.height,
        new Set(),
        (candidate.branches || []).map((b) => ({
          group: b.union,
          route: b.route,
        })),
      );
      if (routes.length !== (original.routes || []).length) continue;
      candidate = { ...candidate, routes };
    }
    const next = score(candidate),
      current = score(best);
    if (
      familyRowNoWorse(next, current) &&
      familyRowNoWorse(next, initial) &&
      next.crossings < current.crossings
    )
      best = candidate;
  }
  return best;
}
