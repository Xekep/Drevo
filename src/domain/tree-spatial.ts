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

/** Shared by the CPU projection and billboard shaders. */
export function spatialCardLimit(viewportWidth: number) {
  return viewportWidth < 600 ? 150 : 190;
}

/** Density reduces size, never the set of available names and portraits. */
export function spatialCardFloor(
  viewportWidth: number,
  visibleCount: number,
  occupiedArea = Infinity,
) {
  return Math.max(
    viewportWidth < 600 ? 18 : 20,
    Math.min(
      (viewportWidth < 600 ? 96 : 112) *
        Math.min(1, Math.sqrt(100 / Math.max(1, visibleCount))),
      1.2 * Math.sqrt(occupiedArea / Math.max(1, visibleCount)),
    ),
  );
}
