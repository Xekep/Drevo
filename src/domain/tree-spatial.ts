import type { Person, FamilyUnion } from "./types.ts";
import type { TreeGeometry } from "./tree-layout.ts";
import type { DepthConnection } from "./tree-depth.ts";

export type SpatialPoint = { x: number; y: number; z: number; angle: number };
export type SpatialWorld = {
  points: Map<string, SpatialPoint>;
  connections: DepthConnection[];
  radius: number;
};

/** Bend the authoritative generation layout into space. No force simulation,
 * invented relationships, duplicated ancestors or dependence on camera/selection.
 * Arc length preserves horizontal clearance; Y retains the generation ordering.
 */
export function spatialWorld(
  people: ReadonlyMap<string, Person>,
  geometry: TreeGeometry,
  unions: readonly FamilyUnion[] = [],
): SpatialWorld {
  const flat = new Map<string, { x: number; y: number }>();
  const occurrences = new Map(
    geometry.occurrences?.map((o) => [o.id, o.personId]),
  );
  for (const [id, p] of geometry.positions) {
    const personId = occurrences.get(id) || id;
    if (people.has(personId) && !flat.has(personId)) flat.set(personId, p);
  }
  let left = Infinity,
    right = -Infinity,
    top = Infinity,
    bottom = -Infinity;
  for (const p of flat.values()) {
    left = Math.min(left, p.x);
    right = Math.max(right, p.x);
    top = Math.min(top, p.y);
    bottom = Math.max(bottom, p.y);
  }
  const radius = Math.max(700, (right - left || 0) / 2.4);
  const points = new Map<string, SpatialPoint>();
  for (const [id, p] of flat) {
    const angle = (p.x - (left + right) / 2) / radius;
    points.set(id, {
      x: radius * Math.sin(angle),
      y: (top + bottom) / 2 - p.y,
      z: radius * (Math.cos(angle) - 1),
      angle,
    });
  }
  const connections: DepthConnection[] = [],
    seen = new Set<string>();
  const add = (from: string, to: string, type: DepthConnection["type"]) => {
    if (!points.has(from) || !points.has(to) || from === to) return;
    const key = JSON.stringify(
      type === "partner" ? [type, ...[from, to].sort()] : [type, from, to],
    );
    if (!seen.has(key)) {
      seen.add(key);
      connections.push({ from, to, type });
    }
  };
  for (const id of points.keys()) {
    const person = people.get(id)!;
    for (const parent of person.parents) add(parent, id, "parent");
    for (const spouse of person.spouses) add(id, spouse, "partner");
  }
  for (const {
    participants: [a, b],
  } of unions)
    add(a, b, "partner");
  return { points, connections, radius };
}

/** Bounded screen-space LOD: detailed labels never grow with archive size. */
export function spatialDetailIds(
  candidates: readonly {
    id: string;
    x: number;
    y: number;
    size: number;
    distance: number;
  }[],
  width: number,
  height: number,
  anchor: string,
  limit: number,
) {
  const result: string[] = [],
    boxes: { x: number; y: number; w: number; h: number }[] = [];
  const ordered = [...candidates].sort(
    (a, b) =>
      Number(b.id === anchor) - Number(a.id === anchor) ||
      a.distance - b.distance ||
      a.id.localeCompare(b.id),
  );
  for (const c of ordered) {
    if (result.length >= limit) break;
    if (
      c.size < 42 ||
      c.x < -c.size ||
      c.y < -c.size ||
      c.x > width + c.size ||
      c.y > height + c.size
    )
      continue;
    const box = { x: c.x, y: c.y, w: c.size * 0.5 + 5, h: c.size * 0.5 + 5 };
    if (
      c.id !== anchor &&
      boxes.some(
        (b) =>
          Math.abs(b.x - box.x) < b.w + box.w &&
          Math.abs(b.y - box.y) < b.h + box.h,
      )
    )
      continue;
    result.push(c.id);
    boxes.push(box);
  }
  return result;
}
