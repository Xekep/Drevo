import type { TreeGeometry } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import type { TreeNodeSize } from "./tree-layout-constants.ts";
import { routeKey, routeRelationships, segmentHitsBox, Spatial, bounds, type Box } from "./edge-routing.ts";
import { routingQuality } from "./routing-quality.ts";

export const ADDITIONAL_ROUTE_LIMITS = { people: 1600, candidates: 128, search: 120000 };

/** Resolve extra ties around the finished family, without moving cards or family lines. */
export function repairAdditionalRoutes(
  original: TreeGeometry,
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  size: TreeNodeSize,
  maxCandidates = ADDITIONAL_ROUTE_LIMITS.candidates,
): TreeGeometry {
  const limit = Math.min(ADDITIONAL_ROUTE_LIMITS.candidates, Math.max(0, Math.floor(maxCandidates)));
  if (!limit || original.mode !== "generations" || !original.routes?.length ||
      original.positions.length > ADDITIONAL_ROUTE_LIMITS.people) return original;
  const families = (original.branches || []).map(b => ({ group: b.union, route: b.route }));
  type RoutedGeometry = TreeGeometry & { routes: NonNullable<TreeGeometry["routes"]> };
  const seed = original as RoutedGeometry;
  const score = (g: RoutedGeometry) => routingQuality([
    ...families, ...g.routes.map(([id, route]) => ({ group: `extra:${id}`, route })),
  ]);
  const initial = score(seed);
  const candidates = links.filter(link => !["parent", "spouse"].includes(link.type) &&
    initial.groups.has(`extra:${routeKey(link)}`)).sort((a, b) =>
      initial.groups.get(`extra:${routeKey(b)}`)! - initial.groups.get(`extra:${routeKey(a)}`)! ||
      routeKey(a).localeCompare(routeKey(b)));
  if (!candidates.length) return original;
  const cards = new Spatial<Box>();
  const extent = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  const include = (x: number, y: number) => {
    extent.left = Math.min(extent.left, x); extent.right = Math.max(extent.right, x);
    extent.top = Math.min(extent.top, y); extent.bottom = Math.max(extent.bottom, y);
  };
  for (const [, p] of original.positions) {
    cards.add({ left: p.x, top: p.y, right: p.x + size.width, bottom: p.y + size.height });
    include(p.x, p.y); include(p.x + size.width, p.y + size.height);
  }
  for (const { route } of [...families, ...seed.routes.map(([, route]) => ({ route }))])
    for (const p of route.points) include(p.x, p.y);
  const hits = (route: NonNullable<TreeGeometry["routes"]>[number][1]) => {
    let count = 0;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1], b = route.points[i];
      count += cards.query(bounds(a, b)).filter(box => segmentHitsBox(a, b, box)).length;
    }
    return count;
  };
  const familyLength = routingQuality(families).length;
  const extraLength = initial.length - familyLength;
  const maxLength = initial.length + Math.min(initial.length * 0.02, extraLength * 0.2, size.width * 12);
  const people = original.positions.map(([id]) => ({ id, birth: "", parents: [], spouses: [] }));
  const searchBudget = { remaining: ADDITIONAL_ROUTE_LIMITS.search };
  let current = seed, best = seed, quality = initial, bestQuality = initial, attempts = 0;
  // A speculative pass may temporarily use extra turns; only a finished route
  // set within four extra turns can be returned. Length is bounded cumulatively.
  const handles = ["top", "bottom", "left", "right"] as const;
  for (let pass = 0; pass < 2; pass++) {
    const before = current;
    for (const link of candidates) {
      const key = routeKey(link);
      for (const sourceHandle of handles) for (const targetHandle of handles) {
        if (attempts++ >= limit) return best;
        const existing = current.routes.find(([id]) => id === key)?.[1];
        if (!existing || (existing.sourceHandle === sourceHandle && existing.targetHandle === targetHandle)) continue;
        const occupied = [...families, ...current.routes.filter(([id]) => id !== key)
          .map(([id, route]) => ({ group: `extra:${id}`, route }))];
        const proposed = routeRelationships(people, [link], current.positions, size.width, size.height,
          new Set(), occupied, new Map([[key, { sourceHandle, targetHandle, searchBudget, optional: true }]]))[0];
        if (!proposed || proposed[1].points.some(p => p.x < extent.left || p.x > extent.right ||
            p.y < extent.top || p.y > extent.bottom) || hits(proposed[1]) > hits(existing)) continue;
        const candidate = { ...current, routes: current.routes.map(route => route[0] === key ? proposed : route) };
        const next = score(candidate);
        if (next.crossings > quality.crossings || next.contacts > quality.contacts ||
            next.length > maxLength || next.bends > initial.bends + 8 ||
            !(next.crossings < quality.crossings ||
              (next.contacts < quality.contacts && next.length <= quality.length))) continue;
        current = candidate;
        quality = next;
        if (next.bends <= initial.bends + 4 &&
            (next.crossings < bestQuality.crossings ||
              (next.crossings === bestQuality.crossings && next.contacts < bestQuality.contacts))) {
          best = candidate;
          bestQuality = next;
        }
      }
    }
    if (current === before) break;
  }
  return best;
}
