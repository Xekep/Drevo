import {
  routeRelationships,
  routeKey,
  simplifyRoute,
  Spatial,
  type Box,
  type EdgeRoute,
  type RouteHint,
} from "./edge-routing.ts";
import {
  TREE_NODE_WIDTH as W,
  TREE_NODE_HEIGHT as H,
  type LayoutPerson,
  type TreeGeometry,
} from "./tree-layout.ts";
import type { Point } from "./layout-order.ts";
import type { UnionBranch } from "./union-layout.ts";
import { optimizeBranches } from "./branch-routing.ts";
import {
  routingQuality,
  routingCost,
  type RoutedGroup,
} from "./routing-quality.ts";

const distance = (a: Point, b: Point) =>
  Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Точка подключения лежит на готовой линии пары, а не на общем тупиковом хвосте. */
function familyJunction(
  route: EdgeRoute,
  children: Point[],
  cards: Spatial<Box>,
) {
  const points = route.points;
  const total = points
    .slice(1)
    .reduce((sum, p, i) => sum + distance(points[i], p), 0);
  const center = {
    x: (points[0].x + points.at(-1)!.x) / 2,
    y: (points[0].y + points.at(-1)!.y) / 2,
  };
  const desired = children.length
    ? {
        x: [...children].sort((a, b) => a.x - b.x)[
          Math.floor(children.length / 2)
        ].x,
        y: [...children].sort((a, b) => a.y - b.y)[
          Math.floor(children.length / 2)
        ].y,
      }
    : center;
  let walked = 0,
    best: Point | undefined,
    score = Infinity;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      length = distance(a, b);
    if (!length) continue;
    const along =
      a.x === b.x
        ? Math.abs(
            Math.max(
              Math.min(a.y, b.y),
              Math.min(Math.max(a.y, b.y), desired.y),
            ) - a.y,
          )
        : Math.abs(
            Math.max(
              Math.min(a.x, b.x),
              Math.min(Math.max(a.x, b.x), desired.x),
            ) - a.x,
          );
    for (const offset of [
      length / 2,
      along,
      Math.max(0, 12 - walked),
      Math.min(length, total - 12 - walked),
    ]) {
      if (
        offset < 0 ||
        offset > length ||
        walked + offset < 12 ||
        walked + offset > total - 12
      )
        continue;
      const p = {
        x: a.x + Math.sign(b.x - a.x) * offset,
        y: a.y + Math.sign(b.y - a.y) * offset,
      };
      if (
        cards
          .query({ left: p.x, right: p.x, top: p.y, bottom: p.y })
          .some(
            (box) =>
              p.x > box.left &&
              p.x < box.right &&
              p.y > box.top &&
              p.y < box.bottom,
          )
      )
        continue;
      const value = distance(p, desired) + Math.abs(p.x - center.x) * 0.3;
      if (value < score) {
        best = p;
        score = value;
      }
    }
    walked += length;
  }
  return best;
}

/** Сначала единая линия пары, затем общие семейные ветви к детям. */
function calculateBranches(
  base: TreeGeometry,
  positions: [string, Point][],
  reverse: boolean,
  searchBudget: { remaining: number },
  occupied: RoutedGroup[] = [],
  sideChildren = false,
) {
  const points = new Map(positions),
    cards = new Spatial<Box>();
  for (const [, p] of positions)
    cards.add({
      left: p.x - 10,
      right: p.x + W + 10,
      top: p.y - 10,
      bottom: p.y + H + 10,
    });
  const projected: LayoutPerson[] = positions.map(([id]) => ({
    id,
    birth: "",
    parents: [],
    spouses: [],
  }));
  const people = new Map(projected.map((p) => [p.id, p]));
  const pairs = base.branches!.filter((b) => b.id.startsWith("pair:"));
  const children = base.branches!.filter((b) => b.id.startsWith("child:"));
  const familyBounds = new Map(
    pairs.map((pair) => {
      const a = points.get(pair.source)!,
        b = points.get(pair.target)!;
      return [
        pair.union,
        { top: Math.min(a.y, b.y), bottom: Math.max(a.y, b.y) + H },
      ];
    }),
  );
  const hints = new Map<string, RouteHint>();
  for (const pair of pairs) {
    people.get(pair.source)!.spouses.push(pair.target);
    const [from, to] = [pair.source, pair.target].sort();
    hints.set(routeKey({ from, to, type: "spouse" }), {
      searchBudget,
      group: pair.union,
      priority: distance(points.get(from)!, points.get(to)!),
    });
  }
  const pairRoutes = new Map(
    routeRelationships(
      projected,
      [],
      positions,
      W,
      H,
      new Set(),
      occupied,
      hints,
    ),
  );
  const branches: UnionBranch[] = [],
    hubs = new Map<string, string>(),
    virtual = new Set<string>(),
    allPositions = [...positions];
  for (const pair of pairs) {
    const [from, to] = [pair.source, pair.target].sort();
    const found = pairRoutes.get(routeKey({ from, to, type: "spouse" }));
    if (!found) continue;
    const route =
      pair.source === from
        ? found
        : {
            sourceHandle: found.targetHandle,
            targetHandle: found.sourceHandle,
            points: [...found.points].reverse(),
          };
    branches.push({ ...pair, route });
    const targets = children
      .filter((b) => b.union === pair.union)
      .map((b) => {
        const p = points.get(b.target)!;
        return { x: p.x + W / 2, y: p.y + (reverse ? H : 0) };
      });
    const joint = familyJunction(route, targets, cards);
    if (!joint) continue;
    let id = `junction:${pair.union}`;
    while (points.has(id) || virtual.has(id)) id += ":";
    virtual.add(id);
    hubs.set(pair.union, id);
    points.set(id, joint);
    allPositions.push([id, joint]);
    projected.push({ id, birth: "", parents: [], spouses: [] });
  }
  for (const p of projected) p.spouses = [];
  hints.clear();
  for (const child of children) {
    const from =
      child.relations.length === 1 ? child.source : hubs.get(child.union);
    if (!from) continue;
    people.get(child.target)!.parents.push(from);
    const target = points.get(child.target)!,
      source = points.get(from)!;
    const bounds = familyBounds.get(child.union) || {
      top: source.y,
      bottom: source.y + H,
    };
    const middle =
      target.y >= bounds.bottom + 20
        ? bounds.bottom + 24
        : target.y + H <= bounds.top - 20
          ? bounds.top - 24
          : undefined;
    hints.set(routeKey({ from, to: child.target, type: "parent" }), {
      searchBudget,
      group: child.union,
      priority: distance(source, target),
      middle: sideChildren ? undefined : middle,
      ...(sideChildren
        ? {
            targetHandle:
              source.x > target.x + W / 2
                ? ("right" as const)
                : ("left" as const),
            ...(!virtual.has(from)
              ? {
                  sourceHandle:
                    source.x > target.x
                      ? ("left" as const)
                      : ("right" as const),
                }
              : {}),
          }
        : {}),
    });
  }
  const childRoutes = new Map(
    routeRelationships(
      projected,
      [],
      allPositions,
      W,
      H,
      virtual,
      [
        ...occupied,
        ...branches.map((b) => ({ group: b.union, route: b.route })),
      ],
      hints,
    ),
  );
  for (const child of children) {
    const from =
      child.relations.length === 1 ? child.source : hubs.get(child.union);
    if (!from) continue;
    const route = childRoutes.get(
      routeKey({ from, to: child.target, type: "parent" }),
    );
    if (route)
      branches.push({
        ...child,
        route: { ...route, points: simplifyRoute(route.points) },
      });
  }
  return branches;
}

export function timelineBranches(
  base: TreeGeometry,
  positions: [string, Point][],
  reverse: boolean,
) {
  const searchBudget = { remaining: 60000 };
  let branches = optimizeBranches(
    calculateBranches(base, positions, reverse, searchBudget),
    positions,
    W,
    H,
  );
  const routed = (items: UnionBranch[]) =>
    items.map((b) => ({ group: b.union, route: b.route }));
  let quality = routingQuality(routed(branches));
  // Ограниченный повторный проход только по конфликтующим семьям.
  if (positions.length <= 300)
    for (let pass = 0; pass < 2 && quality.contacts; pass++) {
      const candidates = [...quality.groups]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 12);
      let improved = false;
      for (const [union] of candidates) {
        const rest = branches.filter((b) => b.union !== union),
          old = branches.filter((b) => b.union === union);
        for (const sideChildren of [false, true]) {
          const next = calculateBranches(
            {
              ...base,
              branches: base.branches!.filter((b) => b.union === union),
            },
            positions,
            reverse,
            searchBudget,
            routed(rest),
            sideChildren,
          );
          if (next.length !== old.length) continue;
          const combined = [...rest, ...next],
            after = routingQuality(routed(combined));
          if (
            after.contacts <= quality.contacts &&
            after.crossings <= quality.crossings &&
            after.length <= quality.length * 1.12 + W &&
            routingCost(after) < routingCost(quality) - 1
          ) {
            branches = combined;
            quality = after;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
  const byId = new Map(branches.map((b) => [b.id, b]));
  return base.branches!.flatMap((b) =>
    byId.has(b.id) ? [byId.get(b.id)!] : [],
  );
}
