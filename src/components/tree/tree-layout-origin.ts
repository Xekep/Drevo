import type { TreeGeometry } from "../../domain/tree-layout.ts";

type Point = { x: number; y: number };

/** Presentation translation only: cached routes and the solver's coordinates stay immutable. */
export function translateTreeGeometry(geometry: TreeGeometry, offset: Point): TreeGeometry {
  if (!offset.x && !offset.y) return geometry;
  const point = (p: Point) => ({ x: p.x + offset.x, y: p.y + offset.y });
  const route = (r: NonNullable<TreeGeometry["routes"]>[number][1]) => ({ ...r, points: r.points.map(point) });
  return {
    ...geometry,
    positions: geometry.positions.map(([id, p]) => [id, point(p)]),
    routes: geometry.routes?.map(([id, r]) => [id, route(r)]),
    branches: geometry.branches?.map(b => ({ ...b, route: route(b.route) })),
    blocks: geometry.blocks?.map(b => ({ ...b, ...point(b) })),
    siblingGroups: geometry.siblingGroups?.map(b => ({ ...b, ...point(b) })),
    generationBands: geometry.generationBands?.map(b => ({ ...b,
      targetY: b.targetY + offset.y, minY: b.minY + offset.y, maxY: b.maxY + offset.y,
    })),
  };
}

export function treeLayoutOrigin(previous: TreeGeometry, next: TreeGeometry, anchorId?: string | null): Point {
  const oldPositions = new Map(previous.positions), positions = new Map(next.positions);
  const occurrence = (geometry: TreeGeometry, id: string) => geometry.occurrences?.find(o => o.personId === id)?.id || id;
  if (anchorId) {
    const before = oldPositions.get(anchorId) || oldPositions.get(occurrence(previous, anchorId));
    const after = positions.get(anchorId) || positions.get(occurrence(next, anchorId));
    if (before && after) return { x: before.x - after.x, y: before.y - after.y };
  }
  // A removed anchor must not drag the retained scene to an arbitrary origin.
  const shifts = next.positions.flatMap(([id, p]) => {
    const old = oldPositions.get(id);
    return old ? [{ x: old.x - p.x, y: old.y - p.y }] : [];
  });
  const median = (axis: "x" | "y") => shifts.map(p => p[axis]).sort((a, b) => a - b)[Math.floor(shifts.length / 2)] || 0;
  return { x: median("x"), y: median("y") };
}
