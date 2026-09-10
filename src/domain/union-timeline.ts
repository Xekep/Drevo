import type { LayoutPerson, TreeGeometry } from "./tree-layout.ts";
import { TREE_NODE_WIDTH as W, TREE_NODE_HEIGHT as H } from "./tree-layout.ts";
import {
  routeRelationships,
  routeKey,
  type EdgeRoute,
} from "./edge-routing.ts";
import { familyUnions, type UnionBranch } from "./union-layout.ts";
import { dateYear } from "./dates.ts";
import { START_YEAR, yearY } from "./layout.ts";
import type { FamilyLink } from "./types.ts";
import { optimizeBranches } from "./branch-routing.ts";

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
  const positions: TreeGeometry["positions"] = [];
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
  let active: { x: number; y: number }[] = [];
  for (const o of sorted) {
    active = active.filter((p) => p.y + H + 20 > o.y);
    let right = o.x,
      left = o.x;
    for (const p of [...active].sort((a, b) => a.x - b.x))
      if (Math.abs(p.x - right) < W + 32) right = p.x + W + 32;
    for (const p of [...active].sort((a, b) => b.x - a.x))
      if (Math.abs(p.x - left) < W + 32) left = p.x - W - 32;
    const x = o.x - left < right - o.x ? left : right;
    positions.push([o.id, { x, y: o.y }]);
    active.push({ x, y: o.y });
  }
  const points = new Map(positions);
  const units = familyUnions(people);
  const unitOccurrences = new Map<string, typeof occurrences>();
  for (const o of occurrences) {
    const list = unitOccurrences.get(o.block) || [];
    list.push(o);
    unitOccurrences.set(o.block, list);
  }
  const virtual = new Set<string>();
  const hubs = new Map<string, string>();
  const projected: LayoutPerson[] = occurrences.map((o) => ({
    id: o.id,
    birth: "",
    parents: [],
    spouses: [],
  }));
  const projectedMap = new Map(projected.map((p) => [p.id, p]));
  const allPositions = [...positions];
  for (const unit of units) {
    const members = unitOccurrences.get(unit.id)!;
    const pp = members.map((o) => points.get(o.id)!);
    let id = `junction:${unit.id}`;
    while (points.has(id) || virtual.has(id)) id += ":";
    virtual.add(id);
    hubs.set(unit.id, id);
    const sameRow = pp.every((p) => p.y === pp[0].y);
    const desiredX = pp.reduce((n, p) => n + p.x + W / 2, 0) / pp.length;
    const y =
      sameRow && pp.length === 2
        ? pp[0].y + H / 2
        : reverse
          ? Math.min(...pp.map((p) => p.y)) - 30
          : Math.max(...pp.map((p) => p.y)) + H + 30;
    const blockers = positions
      .filter(([, p]) => y > p.y - 14 && y < p.y + H + 14)
      .map(([, p]) => p)
      .sort((a, b) => a.x - b.x);
    let right = desiredX,
      left = desiredX;
    for (const p of blockers)
      if (right > p.x - 14 && right < p.x + W + 14) right = p.x + W + 16;
    for (const p of [...blockers].reverse())
      if (left > p.x - 14 && left < p.x + W + 14) left = p.x - 16;
    const point = { x: desiredX - left <= right - desiredX ? left : right, y };
    points.set(id, point);
    allPositions.push([id, point]);
    projected.push({
      id,
      birth: "",
      parents: members.map((o) => o.id),
      spouses: [],
    });
  }
  for (const b of base.branches!.filter((b) => b.id.startsWith("child:")))
    projectedMap.get(b.target)!.parents = [hubs.get(b.union)!];
  const routes = new Map(
    routeRelationships(projected, [], allPositions, W, H, virtual),
  );
  let branches: UnionBranch[] = [];
  for (const b of base.branches!) {
    const hub = hubs.get(b.union)!;
    let route: EdgeRoute | undefined;
    if (b.id.startsWith("pair:")) {
      const a = routes.get(
        routeKey({ from: b.source, to: hub, type: "parent" }),
      );
      const c = routes.get(
        routeKey({ from: b.target, to: hub, type: "parent" }),
      );
      if (a && c)
        route = {
          sourceHandle: a.sourceHandle,
          targetHandle: c.sourceHandle,
          points: [...a.points, ...c.points.slice(0, -1).reverse()],
        };
    } else {
      const child = routes.get(
        routeKey({ from: hub, to: b.target, type: "parent" }),
      );
      const members = unitOccurrences.get(b.union)!;
      // Не скрываем исходные связи, если общий узел остался без одного из родителей.
      if (
        !members.every((o) =>
          routes.has(routeKey({ from: o.id, to: hub, type: "parent" })),
        )
      )
        continue;
      if (child && members.length === 1) {
        const parent = routes.get(
          routeKey({ from: b.source, to: hub, type: "parent" }),
        );
        if (parent)
          route = {
            ...child,
            sourceHandle: parent.sourceHandle,
            points: [...parent.points, ...child.points.slice(1)],
          };
      } else route = child;
    }
    if (route) branches.push({ ...b, route });
  }
  branches = optimizeBranches(branches, positions, W, H);
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
  const extraRoutes = routeRelationships(
    [
      ...fallbackPeople,
      ...occurrences
        .filter((o) => o.id !== o.personId)
        .map((o) => ({ id: o.id, birth: "", parents: [], spouses: [] })),
    ],
    links,
    positions,
    W,
    H,
    new Set(),
    branches.map((b) => ({ group: b.union, route: b.route })),
  );
  const blocks = (base.blocks || []).flatMap((b) => {
    const ps = b.members.map((id) => points.get(id)!);
    const left = Math.min(...ps.map((p) => p.x)),
      right = Math.max(...ps.map((p) => p.x));
    return ps.every((p) => p.y === ps[0].y) && right - left === W + 32
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
}
