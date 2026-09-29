import type { TreeGeometry, LayoutPerson } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { routeRelationships, simplifyRoute } from "./edge-routing.ts";
import type { UnionBranch } from "./union-layout.ts";

/** Pair blocks whose ancestral junctions arrive in the opposite horizontal order. */
export function invertedCoupleBlocks(
  geometry: TreeGeometry,
  cardWidth: number,
) {
  const positions = new Map(geometry.positions);
  const arrivals = new Map<string, number>();
  for (const branch of geometry.branches || []) {
    if (!branch.id.startsWith("child:")) continue;
    const source = branch.route.points[0];
    if (source) arrivals.set(branch.target, source.x);
  }
  const flipped = new Set<string>();
  for (const block of geometry.blocks || []) {
    if (block.members.length !== 2) continue;
    const [left, right] = [...block.members].sort(
      (a, b) => positions.get(a)!.x - positions.get(b)!.x,
    );
    const leftOrigin = arrivals.get(left),
      rightOrigin = arrivals.get(right);
    if (
      leftOrigin !== undefined &&
      rightOrigin !== undefined &&
      leftOrigin > rightOrigin + cardWidth / 2
    )
      flipped.add(block.id);
  }
  return flipped;
}

/** Reuse ELK block coordinates while rerouting only the incoming lines of reversed couples. */
export function locallyReverseCouples(
  geometry: TreeGeometry,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  requested: ReadonlySet<string> = invertedCoupleBlocks(geometry, size.width),
): TreeGeometry | undefined {
  const flipped = (geometry.blocks || []).filter(
    (block) => requested.has(block.id) && block.members.length === 2,
  );
  if (!flipped.length) return;
  const original = new Map(geometry.positions);
  const swapped = new Map<string, number>();
  for (const block of flipped) {
    const [a, b] = block.members;
    swapped.set(a, original.get(b)!.x);
    swapped.set(b, original.get(a)!.x);
  }
  const positions: TreeGeometry["positions"] = geometry.positions.map(
    ([id, point]) => [
      id,
      swapped.has(id) ? { ...point, x: swapped.get(id)! } : point,
    ],
  );
  const moved = new Set(swapped.keys());
  const placed = new Map(positions);
  let valid = true;
  const branches: UnionBranch[] = (geometry.branches || []).map((branch) => {
    if (
      branch.id.startsWith("pair:") &&
      moved.has(branch.source) &&
      moved.has(branch.target)
    )
      return {
        ...branch,
        route: {
          sourceHandle: branch.route.targetHandle,
          targetHandle: branch.route.sourceHandle,
          points: [...branch.route.points].reverse(),
        },
      };
    if (!branch.id.startsWith("child:") || !moved.has(branch.target))
      return branch;
    const target = placed.get(branch.target);
    const points = branch.route.points;
    if (
      !target ||
      points.length < 2 ||
      (branch.route.targetHandle !== "top" &&
        branch.route.targetHandle !== "bottom")
    ) {
      valid = false;
      return branch;
    }
    const previous = points.at(-2)!,
      last = points.at(-1)!;
    const targetY =
      target.y + (branch.route.targetHandle === "bottom" ? size.height : 0);
    if (previous.x !== last.x || last.y !== targetY) {
      valid = false;
      return branch;
    }
    const center = target.x + size.width / 2;
    const prefix = points.slice(0, -2);
    const before = prefix.at(-1);
    const turn = before?.y === previous.y ? [] : [previous];
    const route = simplifyRoute([
      ...prefix,
      ...turn,
      { x: center, y: previous.y },
      { x: center, y: targetY },
    ]);
    return { ...branch, route: { ...branch.route, points: route } };
  });
  if (!valid) return;
  let extraRoutes = geometry.routes;
  if (links.length) {
    const personIds = new Map(
      (geometry.occurrences || []).map((item) => [item.id, item.personId]),
    );
    const movedPeople = new Set(
      [...moved].map((id) => personIds.get(id) || id),
    );
    if (
      links.some(
        (link) => movedPeople.has(link.from) || movedPeople.has(link.to),
      )
    ) {
      const byId = new Map(people.map((person) => [person.id, person]));
      const extraPeople: LayoutPerson[] = (geometry.occurrences || []).map(
        (item) => ({
          id: item.id,
          birth: byId.get(item.personId)?.birth || "",
          parents: [],
          spouses: [],
        }),
      );
      extraRoutes = routeRelationships(
        extraPeople,
        links,
        positions,
        size.width,
        size.height,
        new Set(),
        branches.map((branch) => ({
          group: branch.union,
          route: branch.route,
        })),
      );
      if (extraRoutes.length !== (geometry.routes || []).length) return;
    }
  }
  return {
    ...geometry,
    positions,
    blocks: geometry.blocks?.map((block) =>
      requested.has(block.id)
        ? { ...block, members: [...block.members].reverse() }
        : block,
    ),
    branches,
    routes: extraRoutes,
  };
}
