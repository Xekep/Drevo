import type { LayoutPerson } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";
import { segmentsCross, type Point } from "./layout-order.ts";

export type Handle = "top" | "bottom" | "left" | "right";
type Relation = { from: string; to: string; type: string };
export type EdgeRoute = {
  sourceHandle: Handle;
  targetHandle: Handle;
  points: Point[];
};
export type RouteHint = {
  group?: string;
  priority?: number;
  sourceHandle?: Handle;
  targetHandle?: Handle;
  middle?: number;
  searchBudget?: { remaining: number };
};
export type Box = { left: number; right: number; top: number; bottom: number };
type Line = { a: Point; b: Point; group: string };
export const routeKey = (e: Relation) => JSON.stringify([e.type, e.from, e.to]);

/** Пространственный индекс: стоимость короткой связи не зависит от размера архива. */
export class Spatial<T extends Box> {
  cells = new Map<string, T[]>();
  add(item: T) {
    this.visit(item, (key) => {
      const list = this.cells.get(key) || [];
      list.push(item);
      this.cells.set(key, list);
    });
  }
  query(box: Box) {
    const found = new Set<T>();
    this.visit(box, (key) => {
      for (const item of this.cells.get(key) || []) found.add(item);
    });
    return [...found].filter(
      (b) =>
        b.left <= box.right &&
        b.right >= box.left &&
        b.top <= box.bottom &&
        b.bottom >= box.top,
    );
  }
  visit(box: Box, fn: (key: string) => void) {
    for (
      let x = Math.floor(box.left / 300);
      x <= Math.floor(box.right / 300);
      x++
    )
      for (
        let y = Math.floor(box.top / 300);
        y <= Math.floor(box.bottom / 300);
        y++
      )
        fn(`${x}:${y}`);
  }
}
export const bounds = (a: Point, b: Point): Box => ({
  left: Math.min(a.x, b.x),
  right: Math.max(a.x, b.x),
  top: Math.min(a.y, b.y),
  bottom: Math.max(a.y, b.y),
});
export function segmentHitsBox(a: Point, b: Point, box: Box) {
  return a.x === b.x
    ? a.x > box.left &&
        a.x < box.right &&
        Math.max(a.y, b.y) > box.top &&
        Math.min(a.y, b.y) < box.bottom
    : a.y > box.top &&
        a.y < box.bottom &&
        Math.max(a.x, b.x) > box.left &&
        Math.min(a.x, b.x) < box.right;
}

/** Учитываем и Т-касания: поворот на чужой линии выглядит как ложное родство. */
export function segmentContact(a: Point, b: Point, c: Point, d: Point) {
  const vertical = a.x === b.x,
    otherVertical = c.x === d.x;
  if (vertical !== otherVertical) {
    const x = vertical ? a.x : c.x,
      y = vertical ? c.y : a.y;
    if (
      x >= Math.min(a.x, b.x) &&
      x <= Math.max(a.x, b.x) &&
      y >= Math.min(a.y, b.y) &&
      y <= Math.max(a.y, b.y) &&
      x >= Math.min(c.x, d.x) &&
      x <= Math.max(c.x, d.x) &&
      y >= Math.min(c.y, d.y) &&
      y <= Math.max(c.y, d.y)
    )
      return `cross:${x}:${y}`;
  } else if (
    vertical &&
    a.x === c.x &&
    Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) >
      Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y))
  )
    return `vertical:${a.x}`;
  else if (
    !vertical &&
    a.y === c.y &&
    Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) >
      Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x))
  )
    return `horizontal:${a.y}`;
  return "";
}
export function simplifyRoute(points: Point[]) {
  const result: Point[] = [];
  for (const p of points) {
    const a = result.at(-2),
      b = result.at(-1);
    if (b && b.x === p.x && b.y === p.y) continue;
    if (
      a &&
      b &&
      ((a.x === b.x && b.x === p.x) || (a.y === b.y && b.y === p.y))
    )
      result.pop();
    result.push(p);
  }
  return result;
}

/** Ортогональные коридоры с общей линией семьи; даты и отношения не меняются. */
export function routeRelationships(
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  positions: [string, Point][],
  width: number,
  height: number,
  pointNodes: Set<string> = new Set(),
  occupied: { group: string; route: EdgeRoute }[] = [],
  hints: ReadonlyMap<string, RouteHint> = new Map(),
): [string, EdgeRoute][] {
  const map = new Map(positions),
    peopleMap = new Map(people.map((p) => [p.id, p]));
  const obstacles = new Spatial<Box>(),
    lines = new Spatial<Box & Line>();
  const addRoute = (points: Point[], group: string) => {
    for (let i = 1; i < points.length; i++) {
      if (points[i - 1].x === points[i].x && points[i - 1].y === points[i].y)
        continue;
      lines.add({
        ...bounds(points[i - 1], points[i]),
        a: points[i - 1],
        b: points[i],
        group,
      });
    }
  };
  for (const edge of occupied) addRoute(edge.route.points, edge.group);
  for (const [id, p] of positions) {
    if (pointNodes.has(id)) continue;
    obstacles.add({
      left: p.x - 10,
      right: p.x + width + 10,
      top: p.y - 10,
      bottom: p.y + height + 10,
    });
  }
  const edges = new Map<string, Relation>();
  const add = (e: Relation) => {
    if (map.has(e.from) && map.has(e.to)) edges.set(routeKey(e), e);
  };
  for (const p of people) {
    for (const from of p.parents) add({ from, to: p.id, type: "parent" });
    for (const spouse of p.spouses) {
      const [from, to] = [p.id, spouse].sort();
      add({ from, to, type: "spouse" });
    }
  }
  for (const link of links) add(link);
  const port = (p: Point, h: Handle, id: string): Point =>
    pointNodes.has(id)
      ? { ...p }
      : {
          x: p.x + (h === "left" ? 0 : h === "right" ? width : width / 2),
          y: p.y + (h === "top" ? 0 : h === "bottom" ? height : height / 2),
        };
  const escape = (p: Point, h: Handle): Point => ({
    x: p.x + (h === "left" ? -10 : h === "right" ? 10 : 0),
    y: p.y + (h === "top" ? -10 : h === "bottom" ? 10 : 0),
  });
  const clear = (a: Point, b: Point) =>
    !obstacles.query(bounds(a, b)).some((box) => segmentHitsBox(a, b, box));
  const cost = (a: Point, b: Point, group: string) => {
    let value = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
    const conflicts = new Set<string>();
    for (const line of lines.query(bounds(a, b))) {
      if (line.group === group) {
        // Совместный участок допустим; собственный крест семьи всё же лучше обойти.
        if (segmentsCross([a, b], [line.a, line.b])) value += 300;
        continue;
      }
      if (segmentContact(a, b, line.a, line.b)) conflicts.add(line.group);
    }
    return value + conflicts.size * 1800;
  };
  const result: [string, EdgeRoute][] = [];
  const sorted = [...edges.values()].sort((a, b) => {
    const rank = (e: Relation) =>
      e.type === "spouse" ? 0 : e.type === "parent" ? 1 : 2;
    return (
      rank(a) - rank(b) ||
      (hints.get(routeKey(a))?.priority || 0) -
        (hints.get(routeKey(b))?.priority || 0) ||
      routeKey(a).localeCompare(routeKey(b))
    );
  });
  for (const edge of sorted) {
    const hint = hints.get(routeKey(edge));
    const a = map.get(edge.from)!,
      b = map.get(edge.to)!;
    const side = edge.type === "spouse" || edge.type === "sworn_sibling";
    let sourceHandle: Handle = side
      ? a.x > b.x
        ? "left"
        : "right"
      : a.y > b.y
        ? "top"
        : "bottom";
    let targetHandle: Handle = side
      ? a.x > b.x
        ? "right"
        : "left"
      : a.y > b.y
        ? "bottom"
        : "top";
    if (
      pointNodes.has(edge.to) &&
      !pointNodes.has(edge.from) &&
      b.y >= a.y &&
      b.y <= a.y + height
    )
      sourceHandle = b.x < a.x ? "left" : "right";
    if (
      pointNodes.has(edge.from) &&
      !pointNodes.has(edge.to) &&
      a.y >= b.y &&
      a.y <= b.y + height
    )
      targetHandle = a.x < b.x ? "left" : "right";
    sourceHandle = hint?.sourceHandle || sourceHandle;
    targetHandle = hint?.targetHandle || targetHandle;
    const start = port(a, sourceHandle, edge.from),
      end = port(b, targetHandle, edge.to),
      s = pointNodes.has(edge.from) ? start : escape(start, sourceHandle),
      t = pointNodes.has(edge.to) ? end : escape(end, targetHandle);
    const parents = peopleMap
      .get(edge.to)!
      .parents.filter((id) => map.has(id))
      .sort();
    const group =
      hint?.group ||
      (pointNodes.has(edge.from)
        ? `junction:${edge.from}`
        : pointNodes.has(edge.to)
          ? `junction:${edge.to}`
          : edge.type === "parent"
            ? `family:${JSON.stringify(parents)}`
            : routeKey(edge));
    let middle = (s.y + t.y) / 2;
    if (edge.type === "parent") {
      const parentPoints = parents.map((id) => map.get(id)!);
      const sameRow = parentPoints.every((p) => p.y === a.y);
      if (sameRow)
        middle =
          a.y > b.y
            ? a.y - 47
            : a.y + (pointNodes.has(edge.from) ? 0 : height) + 47;
    }
    if (hint?.middle !== undefined) middle = hint.middle;
    const candidates: Point[][] = [
      [s, { x: s.x, y: middle }, { x: t.x, y: middle }, t],
      [s, { x: s.x, y: t.y }, t],
      [s, { x: t.x, y: s.y }, t],
    ];
    const familyPath = edge.type === "parent" ? candidates[0] : undefined;
    if (s.x === t.x || s.y === t.y) candidates.unshift([s, t]);
    const nearby = obstacles.query({
      left: Math.min(s.x, t.x) - 60,
      right: Math.max(s.x, t.x) + 60,
      top: Math.min(s.y, t.y) - 60,
      bottom: Math.max(s.y, t.y) + 60,
    });
    const xs = new Set([
      Math.min(s.x, t.x) - width - 40,
      Math.max(s.x, t.x) + width + 40,
    ]);
    const ys = new Set([
      Math.min(s.y, t.y) - height - 40,
      Math.max(s.y, t.y) + height + 40,
    ]);
    for (const box of nearby) {
      xs.add(box.left - 8);
      xs.add(box.right + 8);
      ys.add(box.top - 8);
      ys.add(box.bottom + 8);
    }
    // Коридоры сначала: в обычной семье поиск по графу не нужен.
    for (const x of xs) candidates.push([s, { x, y: s.y }, { x, y: t.y }, t]);
    for (const y of ys) candidates.push([s, { x: s.x, y }, { x: t.x, y }, t]);
    let best: Point[] | undefined,
      bestCost = Infinity;
    for (const raw of candidates) {
      const points = simplifyRoute(raw);
      let value = (points.length - 2) * 12 - (raw === familyPath ? 60 : 0);
      for (let i = 1; i < points.length; i++) {
        if (!clear(points[i - 1], points[i])) {
          value = Infinity;
          break;
        }
        value += cost(points[i - 1], points[i], group);
      }
      if (value < bestCost) {
        best = points;
        bestCost = value;
      }
    }
    const directCost = Math.abs(s.x - t.x) + Math.abs(s.y - t.y);
    if (
      !best ||
      (bestCost > directCost + 1500 &&
        nearby.length <= 160 &&
        (!hint?.searchBudget || hint.searchBudget.remaining > 0))
    ) {
      const guides = lines
        .query({
          left: Math.min(s.x, t.x) - 60,
          right: Math.max(s.x, t.x) + 60,
          top: Math.min(s.y, t.y) - 60,
          bottom: Math.max(s.y, t.y) + 60,
        })
        .filter((line) => line.group !== group)
        .slice(0, 80)
        .flatMap((line) => [line.a, line.b]);
      const found = corridorSearch(
        s,
        t,
        nearby,
        clear,
        (a, b) => cost(a, b, group),
        guides,
        best ? hint?.searchBudget : undefined,
      );
      if (found) {
        const value = found
          .slice(1)
          .reduce(
            (sum, p, i) => sum + cost(found[i], p, group),
            (found.length - 2) * 12,
          );
        if (value < bestCost) {
          best = found;
          bestCost = value;
        }
      }
    }
    // Для необычно плотного архива расширяем область обхода препятствий.
    if (!best) {
      const expanded = obstacles.query({
        left: Math.min(s.x, t.x) - 800,
        right: Math.max(s.x, t.x) + 800,
        top: Math.min(s.y, t.y) - 800,
        bottom: Math.max(s.y, t.y) + 800,
      });
      best = corridorSearch(s, t, expanded, clear, (a, b) => cost(a, b, group));
    }
    if (!best) continue;
    const points = simplifyRoute([start, ...best, end]);
    addRoute(points, group);
    result.push([routeKey(edge), { sourceHandle, targetHandle, points }]);
  }
  return result;
}

/** A* по свободным коридорам вокруг карточек; повороты имеют отдельную цену. */
function corridorSearch(
  start: Point,
  end: Point,
  boxes: Box[],
  clear: (a: Point, b: Point) => boolean,
  cost: (a: Point, b: Point) => number,
  guides: Point[] = [],
  budget?: { remaining: number },
): Point[] | undefined {
  const xs = [
    ...new Set([
      start.x,
      end.x,
      ...guides.flatMap((p) => [p.x - 12, p.x + 12]),
      ...boxes.flatMap((b) => [b.left - 8, b.right + 8]),
    ]),
  ].sort((a, b) => a - b);
  const ys = [
    ...new Set([
      start.y,
      end.y,
      ...guides.flatMap((p) => [p.y - 12, p.y + 12]),
      ...boxes.flatMap((b) => [b.top - 8, b.bottom + 8]),
    ]),
  ].sort((a, b) => a - b);
  type State = {
    x: number;
    y: number;
    direction: number;
    g: number;
    f: number;
    previous?: State;
  };
  const heap: State[] = [];
  const push = (state: State) => {
    let i = heap.push(state) - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent].f <= state.f) break;
      heap[i] = heap[parent];
      i = parent;
    }
    heap[i] = state;
  };
  const pop = () => {
    const first = heap[0],
      last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let child = i * 2 + 1;
        if (child + 1 < heap.length && heap[child + 1].f < heap[child].f)
          child++;
        if (last.f <= heap[child].f) break;
        heap[i] = heap[child];
        i = child;
      }
      heap[i] = last;
    }
    return first;
  };
  const visited = new Map<number, number>();
  push({
    x: xs.indexOf(start.x),
    y: ys.indexOf(start.y),
    direction: 0,
    g: 0,
    f: 0,
  });
  for (
    let count = 0;
    heap.length && count < 60000 && (!budget || budget.remaining > 0);
    count++
  ) {
    if (budget) budget.remaining--;
    const state = pop(),
      a = { x: xs[state.x], y: ys[state.y] };
    const key = (state.y * xs.length + state.x) * 3 + state.direction;
    if ((visited.get(key) ?? Infinity) <= state.g) continue;
    visited.set(key, state.g);
    if (a.x === end.x && a.y === end.y) {
      const points = [a];
      let prev = state.previous;
      while (prev) {
        points.push({ x: xs[prev.x], y: ys[prev.y] });
        prev = prev.previous;
      }
      return simplifyRoute(points.reverse());
    }
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const x = state.x + dx,
        y = state.y + dy;
      if (x < 0 || x >= xs.length || y < 0 || y >= ys.length) continue;
      const b = { x: xs[x], y: ys[y] },
        direction = dx ? 1 : 2;
      if (!clear(a, b)) continue;
      const g =
        state.g +
        cost(a, b) +
        (state.direction && state.direction !== direction ? 12 : 0);
      if ((visited.get((y * xs.length + x) * 3 + direction) ?? Infinity) <= g)
        continue;
      push({
        x,
        y,
        direction,
        g,
        f: g + Math.abs(b.x - end.x) + Math.abs(b.y - end.y),
        previous: state,
      });
    }
  }
}

export function roundedRoute(points: Point[], radius = 7) {
  if (points.length < 2) return { path: "", x: 0, y: 0 };
  let path = `M ${points[0].x} ${points[0].y}`,
    distance = 0;
  const lengths = points
    .slice(1)
    .map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y));
  const half = lengths.reduce((a, b) => a + b, 0) / 2;
  let label = points[0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1],
      b = points[i],
      c = points[i + 1],
      length = lengths[i - 1];
    if (distance <= half && distance + length >= half && length) {
      const t = (half - distance) / length;
      label = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    distance += length;
    if (!c) {
      path += ` L ${b.x} ${b.y}`;
      continue;
    }
    const r = Math.min(radius, length / 2, lengths[i] / 2);
    const before = {
      x: b.x + Math.sign(a.x - b.x) * r,
      y: b.y + Math.sign(a.y - b.y) * r,
    };
    const after = {
      x: b.x + Math.sign(c.x - b.x) * r,
      y: b.y + Math.sign(c.y - b.y) * r,
    };
    path += ` L ${before.x} ${before.y} Q ${b.x} ${b.y} ${after.x} ${after.y}`;
  }
  return { path, ...label };
}
