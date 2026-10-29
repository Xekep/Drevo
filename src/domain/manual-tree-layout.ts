import type { TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import { treeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import { routeFamilyMove, translateFamilyBlocks } from "./family-row-moves.ts";
import { routeRelationships, simplifyRoute } from "./edge-routing.ts";
import { bundleFamilyBranches } from "./family-branch-bundling.ts";

/** One displayed household moves horizontally; no people or generation data change. */
export function moveDisplayedFamily(
  original: TreeGeometry,
  occurrenceId: string,
  requested: number,
  settle = false,
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
): TreeGeometry {
  if (original.mode !== "generations" || !Number.isFinite(requested))
    return original;
  const size = original.nodeSize || treeNodeSize();
  const owner = original.occurrences?.find((o) => o.id === occurrenceId)?.block;
  const row = placedFamilyRows(original, size).find((r) =>
    r.some((b) => b.id === owner),
  );
  const block = row?.find((b) => b.id === owner);
  if (!row || !block) return original;
  let delta = requested;
  if (settle) {
    // The drop may pass another household, but cannot finish inside its cards.
    const intervals = row
      .filter((b) => b.id !== block.id)
      .map((b) => ({
        lo: b.x - block.x - block.width - 16,
        hi: b.x + b.width - block.x + 16,
      }))
      .sort((a, b) => a.lo - b.lo);
    const merged: typeof intervals = [];
    for (const interval of intervals) {
      const previous = merged.at(-1);
      if (previous && interval.lo < previous.hi)
        previous.hi = Math.max(previous.hi, interval.hi);
      else merged.push({ ...interval });
    }
    for (const { lo, hi } of merged)
      if (delta > lo && delta < hi) delta = delta - lo < hi - delta ? lo : hi;
  }
  if (Math.abs(delta) < 0.01) return original;
  const move = translateFamilyBlocks(original, new Map([[block.id, delta]]));
  let geometry = move.geometry;
  geometry = {
    ...geometry,
    routes: original.routes?.map(([key, route]) => {
      const [, from, to] = JSON.parse(key) as string[];
      const source = move.moved.has(from) ? delta : 0,
        target = move.moved.has(to) ? delta : 0;
      if (!source && !target) return [key, route];
      if (source === target)
        return [
          key,
          {
            ...route,
            points: route.points.map((p) => ({ ...p, x: p.x + source })),
          },
        ];
      const first = { ...route.points[0], x: route.points[0].x + source },
        last = { ...route.points.at(-1)!, x: route.points.at(-1)!.x + target },
        y = (first.y + last.y) / 2;
      return [
        key,
        {
          ...route,
          points: simplifyRoute([
            first,
            { x: first.x, y },
            { x: last.x, y },
            last,
          ]),
        },
      ];
    }),
  };
  if (!settle) return geometry;
  geometry = bundleFamilyBranches(routeFamilyMove({ ...move, geometry }, size));
  if (geometry.routes?.length && links.length) {
    const routed = new Map(
      routeRelationships(
        geometry.positions.map(([id]) => ({
          id,
          birth: "",
          parents: [],
          spouses: [],
        })),
        links,
        geometry.positions,
        size.width,
        size.height,
        new Set(),
        (geometry.branches || []).map((b) => ({
          group: b.union,
          route: b.route,
        })),
      ),
    );
    geometry = {
      ...geometry,
      routes: geometry.routes.map(([key, route]) => [
        key,
        routed.get(key) || route,
      ]),
    };
  }
  return geometry;
}
