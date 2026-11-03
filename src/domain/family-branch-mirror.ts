import type { TreeGeometry } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import {
  placedFamilyRows,
  familyBlockConflicts,
} from "./local-family-order.ts";
import type { FamilyBranchMove } from "./family-branch-moves.ts";

/** Reflect one ancestral side about the household that joins it to another
 * family. A shared ancestor connecting both sides makes this move ineligible. */
export function mirroredFamilyBranches(
  geometry: TreeGeometry,
  size: TreeNodeSize,
): FamilyBranchMove[] {
  if (geometry.mode !== "generations" || geometry.positions.length > 600)
    return [];
  const blocks = new Map(
    placedFamilyRows(geometry, size)
      .flat()
      .map((b) => [b.id, b]),
  );
  const owner = new Map(
    (geometry.occurrences || []).map((o) => [o.id, o.block]),
  );
  const neighbors = new Map<string, Set<string>>(),
    parents = new Map<string, Set<string>>();
  for (const edge of geometry.branches || []) {
    if (!edge.id.startsWith("child:")) continue;
    const a = owner.get(edge.source),
      b = owner.get(edge.target);
    if (!a || !b || a === b || !blocks.has(a) || !blocks.has(b)) return [];
    for (const [from, to] of [
      [a, b],
      [b, a],
    ]) {
      if (!neighbors.has(from)) neighbors.set(from, new Set());
      neighbors.get(from)!.add(to);
    }
    if (!parents.has(b)) parents.set(b, new Set());
    parents.get(b)!.add(a);
  }
  const { contacts } = familyBlockConflicts(geometry);
  const boundaries = [...parents]
    .filter(
      ([id, origins]) =>
        origins.size > 1 &&
        (contacts.has(id) || [...origins].some((id) => contacts.has(id))),
    )
    .sort(([a], [b]) => (contacts.get(b) || 0) - (contacts.get(a) || 0));
  const result: FamilyBranchMove[] = [];
  for (const [boundary, origins] of boundaries)
    for (const root of origins) {
      const closure = new Set([root]),
        queue = [root];
      let count = 0,
        valid = true;
      for (let i = 0; i < queue.length && valid; i++) {
        count += blocks.get(queue[i])!.members.length;
        if (count > 64) {
          valid = false;
          break;
        }
        for (const next of neighbors.get(queue[i]) || []) {
          if (next === boundary || closure.has(next)) continue;
          if (origins.has(next) || closure.size >= 32) {
            valid = false;
            break;
          }
          closure.add(next);
          queue.push(next);
        }
      }
      if (!valid || closure.size < 2) continue;
      const anchor = blocks.get(boundary)!,
        axis = anchor.x + anchor.width / 2;
      const moved = new Set(
        [...closure].flatMap((id) => blocks.get(id)!.members),
      );
      const reflect = (point: { x: number; y: number }) => ({
        ...point,
        x: 2 * axis - point.x,
      });
      const handle = (h: "left" | "right" | "top" | "bottom") =>
        h === "left" ? "right" : h === "right" ? "left" : h;
      const preserved = new Set(
        (geometry.branches || [])
          .filter((b) => moved.has(b.source) && moved.has(b.target))
          .map((b) => b.id),
      );
      const positions: TreeGeometry["positions"] = geometry.positions.map(
        ([id, p]) => [
          id,
          moved.has(id) ? { ...p, x: 2 * axis - p.x - size.width } : p,
        ],
      );
      result.push({
        moved,
        preserved,
        distance:
          geometry.positions.reduce(
            (sum, [, p], i) => sum + Math.abs(p.x - positions[i][1].x),
            0,
          ) / geometry.positions.length,
        geometry: {
          ...geometry,
          positions,
          blocks: geometry.blocks?.map((b) =>
            closure.has(b.id)
              ? {
                  ...b,
                  x: 2 * axis - b.x - b.width,
                  members: [...b.members].reverse(),
                }
              : b,
          ),
          branches: geometry.branches?.map((b) =>
            preserved.has(b.id)
              ? {
                  ...b,
                  route: {
                    ...b.route,
                    sourceHandle: handle(b.route.sourceHandle),
                    targetHandle: handle(b.route.targetHandle),
                    points: b.route.points.map(reflect),
                  },
                }
              : {
                  ...b,
                  route: {
                    ...b.route,
                    points: b.route.points.map((p, i) =>
                      (i === 0 && moved.has(b.source)) ||
                      (i === b.route.points.length - 1 && moved.has(b.target))
                        ? reflect(p)
                        : p,
                    ),
                  },
                },
          ),
        },
      });
      if (result.length >= 8) return result;
    }
  return result;
}
