import type { Person, FamilyUnion } from "./types.ts";
import type { TreeGeometry } from "./tree-layout.ts";
import type { DepthConnection } from "./tree-depth.ts";
import {
  spatialBranchLayout,
  type SpatialPoint,
} from "./spatial-branch-layout.ts";

export type { SpatialPoint } from "./spatial-branch-layout.ts";
export type SpatialWorld = {
  points: Map<string, SpatialPoint>;
  connections: DepthConnection[];
};
export type SpatialTopology = {
  flat: Map<string, { x: number; y: number }>;
  connections: DepthConnection[];
  reverse: boolean;
};

/** Accessible topology only; no names, portraits or biographies needed by Worker. */
export function spatialTopology(
  people: ReadonlyMap<string, Person>,
  geometry: TreeGeometry,
  unions: readonly FamilyUnion[] = [],
): SpatialTopology {
  const flat = new Map<string, { x: number; y: number }>();
  const occurrences = new Map(
    geometry.occurrences?.map((o) => [o.id, o.personId]),
  );
  for (const [id, p] of geometry.positions) {
    const personId = occurrences.get(id) || id;
    if (people.has(personId) && !flat.has(personId)) flat.set(personId, p);
  }
  const connections: DepthConnection[] = [],
    seen = new Set<string>();
  const add = (from: string, to: string, type: DepthConnection["type"]) => {
    if (!flat.has(from) || !flat.has(to) || from === to) return;
    const key = JSON.stringify(
      type === "partner" ? [type, ...[from, to].sort()] : [type, from, to],
    );
    if (!seen.has(key)) {
      seen.add(key);
      connections.push({ from, to, type });
    }
  };
  for (const id of flat.keys()) {
    const person = people.get(id)!;
    for (const parent of person.parents) add(parent, id, "parent");
    for (const spouse of person.spouses) add(id, spouse, "partner");
  }
  for (const {
    participants: [a, b],
  } of unions)
    add(a, b, "partner");
  return { flat, connections, reverse: geometry.reverse };
}

/** Synchronous pure entry for tests/offline callers; the UI uses the Worker. */
export function spatialWorld(
  people: ReadonlyMap<string, Person>,
  geometry: TreeGeometry,
  unions: readonly FamilyUnion[] = [],
): SpatialWorld {
  const topology = spatialTopology(people, geometry, unions);
  return {
    points: spatialBranchLayout(
      topology.flat,
      topology.connections,
      topology.reverse,
    ),
    connections: topology.connections,
  };
}

/** Bounded screen-space LOD: detailed labels never grow with archive size. */
export function spatialCardLimit(viewportWidth: number) {
  return viewportWidth < 600 ? 150 : 190;
}

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
