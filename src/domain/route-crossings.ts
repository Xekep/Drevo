import { bounds, roundedRoute, Spatial, type Box } from "./edge-routing.ts";
import type { Point } from "./layout-order.ts";
import {
  visitRouteCrossings,
  type CrossingEdge,
  type CrossingSegment,
} from "./route-crossing-index.ts";
export type { CrossingEdge } from "./route-crossing-index.ts";

export type CrossingPathOptions = { zoom?: number; obstacles?: readonly Box[] };
export type CrossingPathFinder = (
  edges: readonly CrossingEdge[],
  options?: CrossingPathOptions,
) => ReadonlyMap<string, string>;

/** Subscribe to buckets, not camera frames. Geometry changes only at bucket boundaries. */
export function crossingZoomBucket(zoom = 1) {
  return Number.isFinite(zoom)
    ? Math.max(0.05, Math.min(2, Math.round(zoom * 20) / 20))
    : 1;
}

/** Visual selection/permissions intentionally do not invalidate route geometry. */
export function crossingGeometryKey(
  edges: readonly CrossingEdge[],
  options: CrossingPathOptions = {},
) {
  const geometry = edges.map((edge) => [
    edge.id,
    edge.group,
    edge.source,
    edge.target,
    edge.route?.sourceHandle,
    edge.route?.targetHandle,
    edge.route?.points.map(({ x, y }) => [x, y]),
  ]);
  return JSON.stringify([
    geometry,
    crossingZoomBucket(options.zoom),
    options.obstacles?.map((b) => [b.left, b.right, b.top, b.bottom]),
  ]);
}

/** Exact-key LRU. Oversized paths are weakly retained while the prepared scene owns them. */
export function createCrossingPathCache(
  maxEntries = 4,
  maxBytes = 4 * 1024 * 1024,
): CrossingPathFinder {
  type Entry = {
    paths?: ReadonlyMap<string, string>;
    weak?: WeakRef<ReadonlyMap<string, string>>;
    bytes: number;
  };
  const entries = new Map<string, Entry>();
  let bytes = 0;
  return (edges, options) => {
    const key = crossingGeometryKey(edges, options),
      cached = entries.get(key);
    if (cached) {
      const paths = cached.paths || cached.weak?.deref();
      entries.delete(key);
      if (paths) {
        entries.set(key, cached);
        return paths;
      }
      bytes -= cached.bytes;
    }
    const paths = calculateCrossingPaths(edges, options);
    let size = key.length * 2;
    for (const [id, path] of paths) size += (id.length + path.length) * 2;
    if (maxEntries < 1 || key.length * 2 + 32 > maxBytes) return paths;
    const entry: Entry =
      size <= maxBytes
        ? { paths, bytes: size }
        : { weak: new WeakRef(paths), bytes: key.length * 2 + 32 };
    entries.set(key, entry);
    bytes += entry.bytes;
    while (entries.size > maxEntries || bytes > maxBytes) {
      const oldest = entries.keys().next().value!;
      bytes -= entries.get(oldest)!.bytes;
      entries.delete(oldest);
    }
    return paths;
  };
}

const defaultCrossingPaths = createCrossingPathCache();
export const crossingPaths: CrossingPathFinder = (edges, options) =>
  defaultCrossingPaths(edges, options);

type Cut = { from: number; to: number; height?: number };
function mergeCuts(cuts: Cut[]) {
  const merged: Cut[] = [];
  for (const cut of cuts.sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = merged.at(-1);
    if (last && cut.from <= last.to) last.to = Math.max(last.to, cut.to);
    else merged.push({ ...cut });
  }
  return merged;
}

function calculateCrossingPaths(
  edges: readonly CrossingEdge[],
  options: CrossingPathOptions = {},
) {
  const zoom = crossingZoomBucket(options.zoom);
  const radius = Math.max(4, Math.min(40, 6 / zoom));
  const height = Math.max(3, radius / 2),
    undercut = Math.max(3, Math.min(16, 2 / zoom));
  const cards = new Spatial<Box>();
  for (const card of options.obstacles || []) cards.add(card);
  const hits = new Map<CrossingSegment, CrossingSegment[]>();
  let count = 0;
  visitRouteCrossings(edges, (h, v) => {
    let list = hits.get(h);
    if (!list) hits.set(h, (list = []));
    list.push(v);
    count++;
  });
  // Arch validation is capped by 2048 hits. Do not raster-index very long
  // lines into thousands of spatial cells or build anything for a gap-only scene.
  const lines: (Box & { edge: string; index: number })[] = [];
  if (count > 0 && count <= 2048)
    for (const edge of edges) {
      const points = edge.route?.points || [];
      for (let index = 1; index < points.length; index++) {
        const a = points[index - 1],
          b = points[index];
        if (a.x === b.x && a.y === b.y) continue;
        lines.push({ ...bounds(a, b), edge: edge.id, index });
      }
    }
  const cuts = new Map<string, Map<number, Cut[]>>();
  const add = (s: CrossingSegment, cut: Cut) => {
    let segments = cuts.get(s.edge.id);
    if (!segments) cuts.set(s.edge.id, (segments = new Map()));
    let list = segments.get(s.index);
    if (!list) segments.set(s.index, (list = []));
    list.push(cut);
  };
  for (const [h, verticals] of hits) {
    const min = Math.min(h.a.x, h.b.x),
      max = Math.max(h.a.x, h.b.x),
      y = h.a.y;
    // Merge nearby crossings instead of dropping the second one.
    verticals.sort((a, b) => a.a.x - b.a.x);
    const clusters = mergeCuts(
      verticals.map((v) => ({
        from: Math.max(min, v.a.x - radius),
        to: Math.min(max, v.a.x + radius),
      })),
    );
    let memberIndex = 0;
    for (const cluster of clusters) {
      const members: CrossingSegment[] = [];
      while (
        memberIndex < verticals.length &&
        verticals[memberIndex].a.x <= cluster.to
      )
        members.push(verticals[memberIndex++]);
      const archBounds = {
        left: cluster.from - 2,
        right: cluster.to + 2,
        top: y - height - 2,
        bottom: y + 2,
      };
      const arc =
        count <= 2048 &&
        cluster.from > min &&
        cluster.to < max &&
        members.every(
          (v) =>
            Math.min(v.a.y, v.b.y) < y - height - undercut &&
            Math.max(v.a.y, v.b.y) > y + undercut,
        ) &&
        !cards.query(archBounds).length &&
        lines.every(
          (line) =>
            line.right < archBounds.left ||
            line.left > archBounds.right ||
            line.bottom < archBounds.top ||
            line.top > archBounds.bottom ||
            (line.edge === h.edge.id && line.index === h.index) ||
            members.some(
              (v) => line.edge === v.edge.id && line.index === v.index,
            ),
        );
      add(h, { ...cluster, height: arc ? height : undefined });
      if (arc)
        for (const v of members) {
          // Cut at the actual arch/vertical intersection, not its old straight baseline.
          const t = (v.a.x - cluster.from) / (cluster.to - cluster.from);
          const crossingY = y - 4 * height * t * (1 - t);
          add(v, { from: crossingY - undercut, to: crossingY + undercut });
        }
    }
  }
  const paths = new Map<string, string>();
  for (const edge of edges) {
    const segments = cuts.get(edge.id);
    if (!segments || !edge.route) continue;
    const points = edge.route.points,
      parts: string[] = [];
    let chunk: Point[] = [points[0]];
    let connected = false;
    const emit = () => {
      const path =
        chunk.length === 2
          ? `M ${chunk[0].x} ${chunk[0].y} L ${chunk[1].x} ${chunk[1].y}`
          : roundedRoute(chunk).path;
      if (connected)
        parts.push(path.replace(/^M\s+[-\d.e+]+\s+[-\d.e+]+\s*/i, ""));
      else parts.push(path);
    };
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        horizontal = a.y === b.y;
      const direction = (horizontal ? b.x - a.x : b.y - a.y) > 0 ? 1 : -1;
      const list = segments.get(i) || [];
      const ordered = list.some((c) => c.height) ? list : mergeCuts(list);
      ordered.sort((x, y) => direction * (x.from - y.from));
      const point = (value: number): Point =>
        horizontal ? { x: value, y: a.y } : { x: a.x, y: value };
      for (const cut of ordered) {
        const first = point(direction > 0 ? cut.from : cut.to),
          last = point(direction > 0 ? cut.to : cut.from);
        chunk.push(first);
        emit();
        if (cut.height)
          parts.push(
            `Q ${(first.x + last.x) / 2} ${a.y - cut.height * 2} ${last.x} ${last.y}`,
          );
        chunk = [last];
        connected = !!cut.height;
      }
      chunk.push(b);
    }
    emit();
    paths.set(edge.id, parts.join(" "));
  }
  return paths;
}
