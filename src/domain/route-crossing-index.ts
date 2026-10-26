import type { EdgeRoute } from "./edge-routing.ts";
import type { Point } from "./layout-order.ts";

export type CrossingEdge = {
  id: string;
  group: string;
  source?: string;
  target?: string;
  route?: EdgeRoute;
};

export type CrossingSegment = {
  edge: CrossingEdge;
  index: number;
  a: Point;
  b: Point;
};

function sharedEndpoint(h: CrossingSegment, v: CrossingSegment) {
  const x = v.a.x,
    y = h.a.y;
  const at = (point: Point | undefined) => point?.x === x && point.y === y;
  const hId = at(h.edge.route?.points[0])
    ? h.edge.source
    : at(h.edge.route?.points.at(-1))
      ? h.edge.target
      : undefined;
  if (!hId) return false;
  return (
    (hId === v.edge.source && at(v.edge.route?.points[0])) ||
    (hId === v.edge.target && at(v.edge.route?.points.at(-1)))
  );
}

/** Y sweep with an active X range tree: disjoint vertical spans are never scanned. */
export function visitRouteCrossings(
  edges: readonly CrossingEdge[],
  visit: (horizontal: CrossingSegment, vertical: CrossingSegment) => void,
) {
  type Event = { y: number; kind: 0 | 1 | 2; segment: CrossingSegment };
  const events: Event[] = [],
    xs: number[] = [];
  for (const edge of edges) {
    const points = edge.route?.points || [];
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1],
        b = points[index];
      if (a.x === b.x && a.y === b.y) continue;
      const segment = { edge, index, a, b };
      if (a.x === b.x) {
        xs.push(a.x);
        events.push(
          { y: Math.min(a.y, b.y), kind: 0, segment },
          { y: Math.max(a.y, b.y), kind: 2, segment },
        );
      } else if (a.y === b.y) events.push({ y: a.y, kind: 1, segment });
    }
  }
  const coordinates = [...new Set(xs)].sort((a, b) => a - b);
  if (!coordinates.length) return;
  const coordinateIndex = new Map(coordinates.map((x, i) => [x, i]));
  let size = 1;
  while (size < coordinates.length) size *= 2;
  const active = new Int32Array(size * 2);
  const buckets = coordinates.map(() => new Set<CrossingSegment>());
  const update = (index: number) => {
    let node = size + index;
    active[node] = buckets[index].size ? 1 : 0;
    while (node > 1) {
      node >>= 1;
      active[node] = active[node * 2] + active[node * 2 + 1];
    }
  };
  const lowerBound = (x: number) => {
    let low = 0,
      high = coordinates.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (coordinates[mid] < x) low = mid + 1;
      else high = mid;
    }
    return low;
  };
  events.sort((a, b) => a.y - b.y || a.kind - b.kind);
  for (const event of events) {
    const h = event.segment;
    if (event.kind !== 1) {
      const index = coordinateIndex.get(h.a.x)!;
      if (event.kind === 0) buckets[index].add(h);
      else buckets[index].delete(h);
      update(index);
      continue;
    }
    const min = Math.min(h.a.x, h.b.x),
      max = Math.max(h.a.x, h.b.x);
    const from = lowerBound(min),
      end = lowerBound(max);
    const to = coordinates[end] === max ? end : end - 1;
    const query = (node: number, left: number, right: number) => {
      if (!active[node] || right < from || left > to) return;
      if (left === right) {
        for (const v of buckets[left]) {
          if (
            h.edge.id === v.edge.id ||
            h.edge.group === v.edge.group ||
            sharedEndpoint(h, v)
          )
            continue;
          visit(h, v);
        }
        return;
      }
      const middle = (left + right) >>> 1;
      query(node * 2, left, middle);
      query(node * 2 + 1, middle + 1, right);
    };
    if (from <= to) query(1, 0, size - 1);
  }
}
