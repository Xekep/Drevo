import type { ElkNode } from "elkjs";
import type { TreeGeometry } from "./tree-layout.ts";
import { solveBoundedSat } from "./bounded-sat.ts";

export type JointUnionOrder = {
  order: ReadonlyMap<string, number>;
  flippedPairs: ReadonlySet<string>;
  crossings: number;
  originalCrossings: number;
};

const MAX_VARIABLES = 20_000,
  MAX_CLAUSES = 80_000,
  MAX_WORK = 20_000_000;

/** Order whole households AND their two incoming ports. The model only proposes
 * a placement; the finished scene must still pass all geometric quality guards.
 * Limits budget the search, never the people retained by the regular layout. */
export function jointUnionOrder(
  graph: ElkNode,
  sketch: Pick<TreeGeometry, "positions" | "occurrences">,
): JointUnionOrder | undefined {
  const nodes = graph.children || [];
  if (
    !nodes.length ||
    nodes.length > 1000 ||
    nodes.some((n) => !Number.isFinite(n.y) || !Number.isFinite(n.width))
  )
    return;
  const ys = [...new Set(nodes.map((n) => n.y!))].sort((a, b) => a - b);
  const layers = ys.map((y) => nodes.flatMap((n, i) => (n.y === y ? [i] : [])));
  // Preflight before allocating a wide row's cubic transitivity constraints.
  if (
    layers.reduce(
      (s, row) => s + (row.length * (row.length - 1) * (row.length - 2)) / 3,
      0,
    ) >
    MAX_CLAUSES / 2
  )
    return;
  const positions = new Map(sketch.positions),
    members = new Map<string, string[]>();
  for (const o of sketch.occurrences || []) {
    const list = members.get(o.block) || [];
    list.push(o.id);
    members.set(o.block, list);
  }
  const left = nodes.map((n) =>
    Math.min(
      ...(members.get(n.id) || []).map((id) => positions.get(id)?.x ?? NaN),
    ),
  );
  if (left.some((x) => !Number.isFinite(x))) return;
  let count = 1;
  const clauses: number[][] = [[1]],
    hints: number[] = [],
    orders = new Map<string, number>(),
    flips = new Map<number, number>();
  const variable = () => ++count;
  const before = (i: number, j: number): number =>
    i < j ? orders.get(`${i},${j}`)! : -orders.get(`${j},${i}`)!;
  for (const row of layers) {
    for (let a = 0; a < row.length; a++)
      for (let b = a + 1; b < row.length; b++) {
        const v = variable();
        orders.set(`${row[a]},${row[b]}`, v);
        hints[v] = left[row[a]] < left[row[b]] ? 1 : -1;
      }
    for (let a = 0; a < row.length; a++)
      for (let b = a + 1; b < row.length; b++)
        for (let c = b + 1; c < row.length; c++) {
          const x = before(row[a], row[b]),
            y = before(row[b], row[c]),
            z = before(row[a], row[c]);
          clauses.push([-x, -y, z], [x, y, -z]);
        }
  }
  type Port = { node: number; x: number };
  const ports = new Map<string, Port>();
  for (const [i, n] of nodes.entries()) {
    for (const p of n.ports || []) {
      if (!Number.isFinite(p.x) || ports.has(p.id)) return;
      ports.set(p.id, { node: i, x: p.x! });
    }
    const north = (n.ports || []).filter(
      (p) => p.layoutOptions?.["elk.port.side"] === "NORTH",
    );
    // Reversing a two-person household mirrors its incoming AND outgoing ports.
    // Larger multi-partner households retain their internal order.
    const ids = members.get(n.id)!;
    if (ids.length === 2 && north.length === 2) {
      const v = variable();
      flips.set(i, v);
      hints[v] = positions.get(ids[0])!.x > positions.get(ids[1])!.x ? 1 : -1;
    }
  }
  const portBefore = (a: Port, b: Port): number => {
    if (a.node !== b.node) return before(a.node, b.node);
    if (a.x === b.x) return 0;
    const flip = flips.get(a.node);
    return flip ? (a.x < b.x ? -flip : flip) : a.x < b.x ? 1 : -1;
  };
  const edges: [Port, Port][] = [];
  for (const e of graph.edges || []) {
    if (e.sources.length !== 1 || e.targets.length !== 1) return;
    const a = ports.get(e.sources[0]),
      b = ports.get(e.targets[0]);
    if (!a || !b || nodes[a.node].y! >= nodes[b.node].y!) return;
    edges.push([a, b]);
  }
  const costs: number[] = [];
  for (let l = 0; l < layers.length - 1; l++) {
    const es = edges.filter(
      ([a, b]) => nodes[a.node].y === ys[l] && nodes[b.node].y === ys[l + 1],
    );
    if (es.length * es.length > MAX_CLAUSES) return;
    for (let i = 0; i < es.length; i++)
      for (let j = i + 1; j < es.length; j++) {
        if (count >= MAX_VARIABLES / 2 || clauses.length >= MAX_CLAUSES / 2) return;
        const a = portBefore(es[i][0], es[j][0]),
          b = portBefore(es[i][1], es[j][1]);
        if (!a || !b || a === b) continue;
        const c = variable();
        costs.push(c);
        clauses.push([-a, b, c], [a, -b, c]);
      }
  }
  hints[1] = 1;
  const truth = (literal: number, values: ArrayLike<number>) =>
    values[Math.abs(literal)] * (literal > 0 ? 1 : -1) > 0;
  // Crossing variables are the only unhinted variables in the original model.
  for (let i = clauses.length - 2 * costs.length; i < clauses.length; i += 2) {
    const [a, b, c] = clauses[i];
    hints[c] = truth(-a, hints) !== truth(b, hints) ? 1 : -1;
  }
  const originalCrossings = costs.filter((c) => hints[c] > 0).length;
  if (
    !originalCrossings ||
    originalCrossings > 32 ||
    count > MAX_VARIABLES / 2 ||
    clauses.length > MAX_CLAUSES / 2
  )
    return;
  const baseCount = count,
    baseLength = clauses.length,
    budget = { remaining: MAX_WORK };
  let low = 0,
    high = originalCrossings - 1,
    best: Int8Array | undefined;
  let crossings = originalCrossings;
  while (low <= high && budget.remaining > 0) {
    // Seek a useful feasible proposal before spending budget proving a bound.
    const limit = best
      ? (low + high) >> 1
      : Math.max(low, Math.min(high, Math.floor(originalCrossings * 0.6)));
    count = baseCount;
    clauses.length = baseLength;
    // Truncated unary totalizer: sum(costs) <= limit. Balanced merges keep
    // model size bounded even when only a few of many potential crossings fit.
    const totalize = (xs: number[]): number[] => {
      if (xs.length === 1) return xs;
      const mid = xs.length >> 1,
        a = totalize(xs.slice(0, mid)),
        b = totalize(xs.slice(mid)),
        out = Array.from(
          { length: Math.min(a.length + b.length, limit + 1) },
          variable,
        );
      a.forEach((x, i) => clauses.push([-x, out[i]]));
      b.forEach((x, i) => clauses.push([-x, out[i]]));
      for (let i = 0; i < a.length; i++)
        for (let j = 0; j < b.length && i + j + 1 < out.length; j++)
          clauses.push([-a[i], -b[j], out[i + j + 1]]);
      return out;
    };
    const sum = totalize(costs);
    clauses.push([-sum[limit]]);
    if (count > MAX_VARIABLES || clauses.length > MAX_CLAUSES) break;
    const solution = solveBoundedSat(count, clauses, hints, budget);
    if (solution === undefined) break;
    if (solution === null) {
      low = limit + 1;
      continue;
    }
    // Check the solver's full assignment before trusting a speculative order.
    if (!clauses.every((c) => c.some((l) => truth(l, solution)))) break;
    best = solution;
    crossings = costs.filter((c) => truth(c, solution)).length;
    high = crossings - 1;
  }
  if (!best) return;
  const ordered = layers.flatMap((row) =>
    [...row].sort((a, b) => (truth(before(a, b), best!) ? -1 : 1)),
  );
  return {
    order: new Map(ordered.map((i, rank) => [nodes[i].id, rank])),
    flippedPairs: new Set(
      nodes.flatMap((n, i) =>
        flips.has(i) && truth(flips.get(i)!, best!) ? [n.id] : [],
      ),
    ),
    crossings,
    originalCrossings,
  };
}
