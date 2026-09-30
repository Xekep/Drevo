import type { TreeGeometry, LayoutPerson } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import {
  bounds,
  routeRelationships,
  segmentContact,
  simplifyRoute,
  Spatial,
} from "./edge-routing.ts";
import type { UnionBranch } from "./union-layout.ts";

type Block = { id: string; members: string[]; x: number; width: number };

function placedBlocks(geometry: TreeGeometry, size: TreeNodeSize) {
  const positions = new Map(geometry.positions);
  const members = new Map<string, string[]>();
  for (const occurrence of geometry.occurrences || []) {
    const list = members.get(occurrence.block) || [];
    list.push(occurrence.id);
    members.set(occurrence.block, list);
  }
  return new Map([...members].map(([id, ids]) => {
    const xs = ids.map((member) => positions.get(member)?.x);
    if (xs.some((x) => x === undefined)) return [id, undefined] as const;
    return [id, {
      id,
      members: ids,
      x: Math.min(...xs as number[]),
      width: Math.max(...xs as number[]) - Math.min(...xs as number[]) + size.width,
    }] as const;
  }));
}

/** Neighboring equal-size unions can exchange their slots without shifting another card. */
export function adjacentFamilyBlocks(geometry: TreeGeometry, size: TreeNodeSize) {
  const blocks = placedBlocks(geometry, size);
  const result: [string, string][] = [];
  for (const band of geometry.generationBands || []) {
    const inBand = new Set(band.members);
    const row = [...blocks.values()]
      .filter((block): block is Block => !!block &&
        block.members.every((member) => inBand.has(member)))
      .sort((a, b) => a.x - b.x);
    for (let i = 1; i < row.length; i++) {
      const left = row[i - 1], right = row[i];
      if (left.members.length !== right.members.length ||
          left.width !== right.width ||
          left.x + left.width > right.x) continue;
      result.push([left.id, right.id]);
    }
  }
  return result;
}

/** Count existing contacts incident to each union before testing slot exchanges. */
export function familyBlockContactScores(geometry: TreeGeometry) {
  type Point = { x: number; y: number };
  type Segment = ReturnType<typeof bounds> & {
    a: Point; b: Point; branch: UnionBranch;
  };
  const owner = new Map(
    (geometry.occurrences || []).map((item) => [item.id, item.block]),
  );
  const scores = new Map<string, number>();
  const segments = new Spatial<Segment>();
  const seen = new Set<string>();
  for (const branch of geometry.branches || []) {
    const points = branch.route.points;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1], b = points[i];
      if (a.x === b.x && a.y === b.y) continue;
      const box = bounds(a, b);
      for (const other of segments.query(box)) {
        if (other.branch.union === branch.union) continue;
        const contact = segmentContact(a, b, other.a, other.b);
        if (!contact) continue;
        const key = JSON.stringify([[branch.union, other.branch.union].sort(), contact]);
        if (seen.has(key)) continue;
        seen.add(key);
        const touched = new Set([
          owner.get(branch.source), owner.get(branch.target),
          owner.get(other.branch.source), owner.get(other.branch.target),
        ]);
        for (const block of touched)
          if (block) scores.set(block, (scores.get(block) || 0) + 1);
      }
      segments.add({ ...box, a, b, branch });
    }
  }
  return scores;
}

/** Exchange union slots and reconnect only their terminal branch segments. */
export function locallySwapFamilyBlocks(
  geometry: TreeGeometry,
  leftId: string,
  rightId: string,
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
): TreeGeometry | undefined {
  const blocks = placedBlocks(geometry, size);
  const left = blocks.get(leftId), right = blocks.get(rightId);
  if (!left || !right || left.members.length !== right.members.length ||
      left.width !== right.width || left.x + left.width > right.x) return;
  const deltas = new Map<string, number>();
  for (const id of left.members) deltas.set(id, right.x - left.x);
  for (const id of right.members) deltas.set(id, left.x - right.x);
  const positions: TreeGeometry["positions"] = geometry.positions.map(([id, point]) => [
    id, deltas.has(id) ? { ...point, x: point.x + deltas.get(id)! } : point,
  ]);
  let valid = true;
  const branches: UnionBranch[] = (geometry.branches || []).map((branch) => {
    const source = deltas.get(branch.source) || 0;
    const target = deltas.get(branch.target) || 0;
    if (!source && !target) return branch;
    if (branch.id.startsWith("pair:")) {
      if (source !== target) valid = false;
      return {
        ...branch,
        route: { ...branch.route, points: branch.route.points.map((point) =>
          ({ ...point, x: point.x + source })) },
      };
    }
    const points = branch.route.points;
    if (!branch.id.startsWith("child:") || points.length < 4 ||
        points[0].x !== points[1].x ||
        points[1].y !== points[2].y ||
        points.at(-2)!.x !== points.at(-1)!.x ||
        points.at(-3)!.y !== points.at(-2)!.y) {
      valid = false;
      return branch;
    }
    const rerouted = points.map((point, index) => ({
      ...point,
      x: point.x + (index < 2 ? source : index >= points.length - 2 ? target : 0),
    }));
    return { ...branch, route: { ...branch.route, points: simplifyRoute(rerouted) } };
  });
  if (!valid) return;
  let routes = geometry.routes;
  if (links.length) {
    const personIds = new Map(
      (geometry.occurrences || []).map((item) => [item.id, item.personId]),
    );
    const moved = new Set([...deltas.keys()].map((id) => personIds.get(id) || id));
    if (links.some((link) => moved.has(link.from) || moved.has(link.to))) {
      const byId = new Map(people.map((person) => [person.id, person]));
      const extraPeople: LayoutPerson[] = (geometry.occurrences || []).map((item) => ({
        id: item.id,
        birth: byId.get(item.personId)?.birth || "",
        parents: [],
        spouses: [],
      }));
      routes = routeRelationships(extraPeople, links, positions, size.width,
        size.height, new Set(), branches.map((branch) => ({
          group: branch.union, route: branch.route,
        })));
      if (routes.length !== (geometry.routes || []).length) return;
    }
  }
  return {
    ...geometry,
    positions,
    branches,
    routes,
    blocks: geometry.blocks?.map((block) =>
      block.id === leftId ? { ...block, x: block.x + right.x - left.x } :
      block.id === rightId ? { ...block, x: block.x + left.x - right.x } : block),
  };
}
