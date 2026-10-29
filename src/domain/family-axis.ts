import type { TreeGeometry } from "./tree-layout.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { placedFamilyRows } from "./local-family-order.ts";
import type { UnionBranch } from "./union-layout.ts";

export const LINEAGE_LIMITS = {
  people: 1200,
  chains: 32,
  blocks: 32,
  states: 128,
  routes: 9,
};
export type AxisBlock = ReturnType<typeof placedFamilyRows>[number][number];
export type LineageChain = { blocks: AxisBlock[]; edges: UnionBranch[] };

/** Unbranched household paths; a second known ancestral line is a boundary. */
export function lineageChains(
  geometry: TreeGeometry,
  size: TreeNodeSize,
): LineageChain[] {
  if (
    geometry.mode !== "generations" ||
    geometry.positions.length > LINEAGE_LIMITS.people
  )
    return [];
  const rows = placedFamilyRows(geometry, size);
  const blocks = new Map(
    rows.flatMap((row) => row.map((b) => [b.id, b] as const)),
  );
  const levels = new Map(
    rows.flatMap((row, level) => row.map((b) => [b.id, level] as const)),
  );
  const owner = new Map(
    (geometry.occurrences || []).map((o) => [o.id, o.block]),
  );
  const incoming = new Map<string, UnionBranch[]>(),
    outgoing = new Map<string, UnionBranch[]>();
  for (const edge of geometry.branches || []) {
    if (!edge.id.startsWith("child:")) continue;
    const a = owner.get(edge.source),
      b = owner.get(edge.target);
    if (!a || !b || a === b) continue;
    incoming.set(b, [...(incoming.get(b) || []), edge]);
    outgoing.set(a, [...(outgoing.get(a) || []), edge]);
  }
  const next = new Map<string, { edge: UnionBranch; block: AxisBlock }>();
  for (const [id, edges] of outgoing) {
    const parent = blocks.get(id),
      edge = edges[0],
      child = blocks.get(owner.get(edge.target)!);
    if (
      edges.length !== 1 ||
      !parent ||
      !child ||
      parent.members.length > 2 ||
      child.members.length > 2 ||
      incoming.get(child.id)?.length !== 1 ||
      levels.get(id)! >= levels.get(child.id)!
    )
      continue;
    next.set(id, { edge, block: child });
  }
  const roots = [...next.keys()].sort();
  const isRoot = (id: string) => {
    const prior = incoming.get(id);
    return (
      prior?.length !== 1 ||
      next.get(owner.get(prior[0].source)!)?.block.id !== id
    );
  };
  roots.sort((a, b) => Number(isRoot(b)) - Number(isRoot(a)));
  const seen = new Set<string>(),
    chains: LineageChain[] = [];
  for (const id of roots) {
    if (seen.has(id)) continue;
    const chain: LineageChain = { blocks: [blocks.get(id)!], edges: [] };
    seen.add(id);
    while (
      next.has(chain.blocks.at(-1)!.id) &&
      chain.blocks.length < LINEAGE_LIMITS.blocks
    ) {
      const step = next.get(chain.blocks.at(-1)!.id)!;
      if (seen.has(step.block.id)) break;
      chain.edges.push(step.edge);
      chain.blocks.push(step.block);
      seen.add(step.block.id);
    }
    if (chain.blocks.length >= 3) chains.push(chain);
    if (chains.length >= LINEAGE_LIMITS.chains) break;
  }
  return chains;
}

/** Readability measures use households, not canvas width or individual UUID order. */
export function familyAxisQuality(geometry: TreeGeometry, size: TreeNodeSize) {
  const rows = placedFamilyRows(geometry, size);
  const blocks = new Map(
    rows.flatMap((row, level) =>
      row.map((b) => [b.id, { ...b, level }] as const),
    ),
  );
  const owner = new Map(
    (geometry.occurrences || []).map((o) => [o.id, o.block]),
  );
  const groups = new Map<
    string,
    { parent: number; blocks: Set<string>; count: number; level: number }
  >();
  for (const edge of geometry.branches || []) {
    if (!edge.id.startsWith("child:")) continue;
    const source = owner.get(edge.source),
      child = blocks.get(owner.get(edge.target)!);
    if (!source || !child || !edge.route.points.length) continue;
    const key = JSON.stringify([edge.union, source, child.level]);
    const group = groups.get(key) || {
      parent: edge.route.points[0].x,
      blocks: new Set<string>(),
      count: 0,
      level: child.level,
    };
    group.blocks.add(child.id);
    group.count++;
    groups.set(key, group);
  }
  let offset = 0,
    single = 0,
    maxOffset = 0,
    interleavings = 0;
  for (const group of groups.values()) {
    const centers = [...group.blocks].map((id) => {
      const b = blocks.get(id)!;
      return b.x + b.width / 2;
    });
    const lo = Math.min(...centers),
      hi = Math.max(...centers),
      error = Math.abs(group.parent - (lo + hi) / 2);
    offset += error;
    maxOffset = Math.max(maxOffset, error);
    if (group.count === 1) single += error;
    interleavings += rows[group.level].filter(
      (b) =>
        !group.blocks.has(b.id) &&
        b.x + b.width / 2 > lo &&
        b.x + b.width / 2 < hi,
    ).length;
  }
  let lineageDrift = 0,
    lineageSpan = 0;
  for (const chain of lineageChains(geometry, size)) {
    const xs = chain.blocks.map((b) => b.x + b.width / 2).sort((a, b) => a - b);
    const middle = xs[Math.floor(xs.length / 2)];
    lineageDrift +=
      xs.reduce((n, x) => n + Math.abs(x - middle), 0) / xs.length;
    lineageSpan = Math.max(lineageSpan, xs.at(-1)! - xs[0]);
  }
  return {
    offset,
    single,
    maxOffset,
    interleavings,
    lineageDrift,
    lineageSpan,
  };
}
