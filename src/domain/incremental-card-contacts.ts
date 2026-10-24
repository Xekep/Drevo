import type { TreeGeometry } from "./tree-layout.ts";
import {
  bounds,
  segmentHitsBox,
  Spatial,
  type Box,
  type EdgeRoute,
} from "./edge-routing.ts";

type Card = Box & { id: string };
type Index = {
  unique: boolean;
  cards: Map<string, Card>;
  spatial: Spatial<Card>;
  routes: EdgeRoute[];
  hits: number[];
  total: number;
};

/** Exact route/card deltas against one immutable full anchor per layout.
 * Unchanged routes only need checks against moved cards; changed routes query
 * the old card index, excluding moved boxes, then test the replacement boxes.
 */
export function incrementalCardContacts(width: number, height: number) {
  let previous: Index | undefined;
  const intersects = (a: Box, b: Box) =>
    a.left <= b.right &&
    a.right >= b.left &&
    a.top <= b.bottom &&
    a.bottom >= b.top;
  const hits = (
    route: EdgeRoute,
    spatial: Spatial<Card>,
    excluded?: Set<string>,
    replacements: Card[] = [],
  ) => {
    let count = 0;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1],
        b = route.points[i],
        box = bounds(a, b);
      for (const card of spatial.query(box))
        if (!excluded?.has(card.id) && segmentHitsBox(a, b, card)) count++;
      for (const card of replacements)
        if (intersects(box, card) && segmentHitsBox(a, b, card)) count++;
    }
    return count;
  };
  return (geometry: TreeGeometry) => {
    const cards = new Map(
      geometry.positions.map(([id, p]) => [
        id,
        {
          id,
          left: p.x,
          right: p.x + width,
          top: p.y,
          bottom: p.y + height,
        },
      ]),
    );
    const routes = [
      ...(geometry.branches || []).map((b) => b.route),
      ...(geometry.routes || []).map(([, r]) => r),
    ];
    const changedCards = new Set<string>();
    const changedRoutes = new Set<number>();
    const compatible =
      previous?.unique &&
      cards.size === geometry.positions.length &&
      cards.size === previous.cards.size &&
      routes.length === previous.routes.length &&
      [...cards.keys()].every((id) => previous!.cards.has(id));
    if (compatible) {
      for (const [id, card] of cards) {
        const before = previous!.cards.get(id)!;
        if (before.left !== card.left || before.top !== card.top)
          changedCards.add(id);
      }
      routes.forEach((r, i) => {
        if (r !== previous!.routes[i]) changedRoutes.add(i);
      });
      if (!changedCards.size && !changedRoutes.size) return previous!.total;
      if (
        cards.size > 200 &&
        changedCards.size <= 40 &&
        changedRoutes.size <= 40 &&
        changedCards.size <= cards.size / 10 &&
        changedRoutes.size <= routes.length / 10
      ) {
        let total = previous!.total;
        const replacements = [...changedCards].map((id) => cards.get(id)!);
        for (const i of changedRoutes)
          total +=
            hits(routes[i], previous!.spatial, changedCards, replacements) -
            previous!.hits[i];
        if (changedCards.size)
          for (const [index, route] of routes.entries()) {
            if (changedRoutes.has(index)) continue;
            for (let i = 1; i < route.points.length; i++) {
              const a = route.points[i - 1],
                b = route.points[i],
                box = bounds(a, b);
              for (const card of replacements) {
                const old = previous!.cards.get(card.id)!;
                total +=
                  Number(intersects(box, card) && segmentHitsBox(a, b, card)) -
                  Number(intersects(box, old) && segmentHitsBox(a, b, old));
              }
            }
          }
        return total;
      }
    }
    const spatial = new Spatial<Card>();
    // Duplicate IDs are malformed, but the full scorer historically counts
    // every occurrence. Do not collapse them through the lookup map.
    for (const [id, p] of geometry.positions)
      spatial.add({
        id,
        left: p.x,
        right: p.x + width,
        top: p.y,
        bottom: p.y + height,
      });
    const counts = routes.map((r) => hits(r, spatial));
    const total = counts.reduce((sum, count) => sum + count, 0);
    previous = {
      unique: cards.size === geometry.positions.length,
      cards,
      spatial,
      routes,
      hits: counts,
      total,
    };
    return total;
  };
}
