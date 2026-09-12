import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import {
  TREE_NODE_WIDTH as W,
  TREE_NODE_HEIGHT as H,
} from "./tree-layout-constants.ts";
import {
  routeRelationships,
  routeKey,
  type RouteHint,
} from "./edge-routing.ts";
import { dateYear } from "./dates.ts";
import { START_YEAR, yearY } from "./layout.ts";
import type { FamilyLink } from "./types.ts";
import { timelineBranches } from "./timeline-routing.ts";
import { timelinePositions, relaxTimelineCards } from "./timeline-positions.ts";
import { routingQuality, routingCost } from "./routing-quality.ts";

/** Та же проекция союзов; известные даты сохраняют точную координату Y. */
export function unionTimeline(
  people: LayoutPerson[],
  base: TreeGeometry,
  reverse = false,
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
): TreeGeometry {
  const known = new Map(people.map((p) => [p.id, p]));
  const occurrences = base.occurrences!;
  const initial = new Map(base.positions);
  const start = Math.min(
    START_YEAR,
    ...people
      .filter((p) => p.birth)
      .map((p) => Math.floor(dateYear(p.birth) / 10) * 10),
  );
  const undated = occurrences.filter((o) => !known.get(o.personId)!.birth);
  const rows = [...new Set(undated.map((o) => initial.get(o.id)!.y))].sort(
    (a, b) => a - b,
  );
  const rowY = new Map(
    rows.map((y, i) => [y, (reverse ? rows.length - 1 - i : i) * (H + 100)]),
  );
  const offset = rows.length ? rows.length * (H + 100) : 0;
  const sorted = [...occurrences]
    .map((o) => {
      const birth = known.get(o.personId)!.birth;
      return {
        ...o,
        x: initial.get(o.id)!.x,
        y: birth
          ? offset + yearY(dateYear(birth), start, reverse)
          : rowY.get(initial.get(o.id)!.y)!,
      };
    })
    .sort((a, b) => a.y - b.y || a.x - b.x || a.id.localeCompare(b.id));
  const project = (positions: TreeGeometry["positions"]): TreeGeometry => {
    const points = new Map(positions);
    const branches = timelineBranches(base, positions, reverse);
    const covered = new Set(
      branches.flatMap((b) =>
        b.relations
          .filter((r) => b.id.startsWith("child:") || r.type === "spouse")
          .map(routeKey),
      ),
    );
    const fallbackPeople = people.map((p) => ({
      ...p,
      parents: p.parents.filter(
        (from) => !covered.has(routeKey({ from, to: p.id, type: "parent" })),
      ),
      spouses: p.spouses.filter((s) => {
        const [from, to] = [p.id, s].sort();
        return !covered.has(routeKey({ from, to, type: "spouse" }));
      }),
    }));
    const extraPeople = [
      ...fallbackPeople,
      ...occurrences
        .filter((o) => o.id !== o.personId)
        .map((o) => ({ id: o.id, birth: "", parents: [], spouses: [] })),
    ];
    const occupied = branches.map((b) => ({ group: b.union, route: b.route }));
    let extraRoutes = routeRelationships(
      extraPeople,
      links,
      positions,
      W,
      H,
      new Set(),
      occupied,
    );
    if (links.length && links.length <= 80)
      for (const [sourceSide, targetSide] of [
        [false, false],
        [true, false],
        [false, true],
        [true, true],
      ]) {
        const hints = new Map<string, RouteHint>();
        for (const link of links) {
          const a = points.get(link.from),
            b = points.get(link.to);
          if (!a || !b) continue;
          const dx = b.x - a.x,
            dy = b.y - a.y;
          hints.set(routeKey(link), {
            priority: Math.abs(dx) + Math.abs(dy),
            sourceHandle: sourceSide
              ? dx >= 0
                ? "right"
                : "left"
              : dy >= 0
                ? "bottom"
                : "top",
            targetHandle: targetSide
              ? dx > 0
                ? "left"
                : "right"
              : dy >= 0
                ? "top"
                : "bottom",
          });
        }
        const candidate = routeRelationships(
          extraPeople,
          links,
          positions,
          W,
          H,
          new Set(),
          occupied,
          hints,
        );
        const quality = (routes: typeof extraRoutes) =>
          routingQuality([
            ...occupied,
            ...routes.map(([group, route]) => ({ group, route })),
          ]);
        const before = quality(extraRoutes),
          after = quality(candidate);
        const keys = new Set(candidate.map(([key]) => key));
        if (
          extraRoutes.every(([key]) => keys.has(key)) &&
          after.contacts <= before.contacts &&
          after.crossings <= before.crossings &&
          routingCost(after) < routingCost(before)
        )
          extraRoutes = candidate;
      }
    const blocks = (base.blocks || []).flatMap((b) => {
      const ps = b.members.map((id) => points.get(id)!);
      const left = Math.min(...ps.map((p) => p.x)),
        right = Math.max(...ps.map((p) => p.x));
      return ps.every((p) => p.y === ps[0].y) &&
        Math.abs(right - left - W - 32) < 0.01
        ? [{ ...b, x: left, y: ps[0].y, width: right - left + W }]
        : [];
    });
    return {
      mode: "timeline",
      reverse,
      start,
      offset,
      positions,
      occurrences,
      blocks,
      branches,
      routes: extraRoutes,
      coveredRelations: [...covered],
    };
  };
  let best = project(timelinePositions(sorted));
  const quality = (g: TreeGeometry) =>
    routingQuality([
      ...(g.branches || []).map((b) => ({ group: b.union, route: b.route })),
      ...(g.routes || []).map(([group, route]) => ({ group, route })),
    ]);
  const width = (g: TreeGeometry) =>
    g.positions.length
      ? Math.max(...g.positions.map(([, p]) => p.x + W)) -
        Math.min(...g.positions.map(([, p]) => p.x))
      : 0;
  let before = quality(best);
  const maxWidth = width(best) * 1.15 + W;
  if (sorted.length > 1 && sorted.length <= 300) {
    let cards = sorted;
    for (let pass = 0; pass < 2; pass++) {
      const next = timelinePositions(relaxTimelineCards(cards, base.branches!));
      const map = new Map(next);
      cards = cards.map((p) => ({ ...p, ...map.get(p.id)! }));
      const candidate = project(next),
        after = quality(candidate);
      if (
        candidate.branches!.length === best.branches!.length &&
        candidate.routes!.length === best.routes!.length &&
        width(candidate) <= maxWidth &&
        after.length <= before.length * 1.15 + W &&
        after.contacts <= before.contacts &&
        after.crossings <= before.crossings &&
        routingCost(after) < routingCost(before) - 1
      ) {
        best = candidate;
        before = after;
      }
    }
  }
  return best;
}
