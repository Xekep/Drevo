import { roundedRoute, type EdgeRoute } from "./edge-routing.ts";
import type { Point } from "./layout-order.ts";

/** Разрывы только на пересечениях разных ветвей, не на семейных развилках. */
export function crossingPaths(
  edges: { id: string; group: string; route?: EdgeRoute }[],
) {
  type Segment = {
    edge: string;
    group: string;
    index: number;
    a: Point;
    b: Point;
  };
  const horizontal: Segment[] = [],
    vertical: Segment[] = [];
  for (const edge of edges) {
    const points = edge.route?.points || [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      if (a.x === b.x && a.y === b.y) continue;
      const segment = { edge: edge.id, group: edge.group, index: i, a, b };
      if (a.y === b.y) horizontal.push(segment);
      else if (a.x === b.x) vertical.push(segment);
    }
  }
  vertical.sort((a, b) => a.a.x - b.a.x);
  const gaps = new Map<string, Map<number, number[]>>();
  for (const h of horizontal) {
    const min = Math.min(h.a.x, h.b.x) + 9,
      max = Math.max(h.a.x, h.b.x) - 9;
    let low = 0,
      high = vertical.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (vertical[mid].a.x <= min) low = mid + 1;
      else high = mid;
    }
    for (let i = low; i < vertical.length && vertical[i].a.x < max; i++) {
      const v = vertical[i];
      if (
        h.group === v.group ||
        h.edge === v.edge ||
        h.a.y <= Math.min(v.a.y, v.b.y) + 1 ||
        h.a.y >= Math.max(v.a.y, v.b.y) - 1
      )
        continue;
      if (!gaps.has(h.edge)) gaps.set(h.edge, new Map());
      const segments = gaps.get(h.edge)!;
      const points = segments.get(h.index) || [];
      points.push(v.a.x);
      segments.set(h.index, points);
    }
  }
  const paths = new Map<string, string>();
  for (const edge of edges) {
    const crossings = gaps.get(edge.id);
    if (!crossings || !edge.route) continue;
    const points = edge.route.points;
    let chunk = [points[0]];
    const chunks: Point[][] = [];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        direction = b.x > a.x ? 1 : -1;
      const xs = [...new Set(crossings.get(i) || [])].sort(
        (x, y) => direction * (x - y),
      );
      let previous: number | undefined;
      for (const x of xs) {
        if (previous !== undefined && Math.abs(x - previous) < 12) continue;
        chunk.push({ x: x - direction * 5, y: a.y });
        chunks.push(chunk);
        chunk = [{ x: x + direction * 5, y: a.y }];
        previous = x;
      }
      chunk.push(b);
    }
    chunks.push(chunk);
    paths.set(edge.id, chunks.map((part) => roundedRoute(part).path).join(" "));
  }
  return paths;
}
