import { routeRelationships, type EdgeRoute } from "./edge-routing.ts";
import { householdBands } from "./household-bands.ts";
import { segmentsCross, type Point } from "./layout-order.ts";
import type { LayoutPerson } from "./tree-layout.ts";
import type { FamilyLink } from "./types.ts";

/** Локальные перестановки целых семей с оценкой реальных линий, а не диагоналей. */
export function arrangeHouseholds(
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[],
  initial: [string, Point][],
  width: number,
  height: number,
) {
  let positions = initial,
    routes = routeRelationships(people, links, initial, width, height);
  // Предсказуемая работа Worker на больших архивах; основная раскладка остаётся линейной.
  if (
    people.length > 100 ||
    people.length < 4 ||
    routes.length > 240 ||
    routes.reduce((sum, [, route]) => sum + route.points.length, 0) > 1200
  )
    return { positions, routes };
  const family = new Map(
    people.map((p) => [p.id, JSON.stringify([...p.parents].sort())]),
  );
  function score(paths: [string, EdgeRoute][]) {
    const segments = paths.flatMap(([key, route]) => {
      const [type, from, to] = JSON.parse(key) as string[];
      const group = type === "parent" ? `family:${family.get(to)}` : key;
      return route.points
        .slice(1)
        .map((b, i) => ({ a: route.points[i], b, type, group, from, to }));
    });
    let crossings = 0,
      length = 0;
    const seen = new Set<string>();
    for (let i = 0; i < segments.length; i++) {
      const a = segments[i];
      length += Math.abs(a.a.x - a.b.x) + Math.abs(a.a.y - a.b.y);
      for (let j = 0; j < i; j++) {
        const b = segments[j];
        if (a.group === b.group || !segmentsCross([a.a, a.b], [b.a, b.b]))
          continue;
        const x = a.a.x === a.b.x ? a.a.x : b.a.x,
          y = a.a.y === a.b.y ? a.a.y : b.a.y;
        const key = `${[a.group, b.group].sort().join("|")}:${x}:${y}`;
        if (seen.has(key)) continue;
        seen.add(key);
        crossings += [a.type, b.type].every(
          (type) => type === "parent" || type === "spouse",
        )
          ? 8
          : 1;
      }
    }
    return { crossings, length, count: paths.length };
  }
  let best = score(routes),
    attempts = 0;
  if (!best.crossings) return { positions, routes };
  const bands = householdBands(people, new Map(initial), width, height),
    used = new Set(bands.flatMap((b) => b.members));
  const units = [
    ...bands.map((b) => b.members),
    ...initial.filter(([id]) => !used.has(id)).map(([id]) => [id]),
  ];
  const rows = new Map<number, string[][]>();
  const first = new Map(initial);
  for (const unit of units) {
    const y = first.get(unit[0])!.y,
      row = rows.get(y) || [];
    row.push(unit);
    rows.set(y, row);
  }
  // Перемещаем соседние уровни согласованно: одно изменение ряда может
  // временно ухудшить линии, пока его дети ещё стоят на прежнем месте.
  const adjacent = new Map(people.map((p) => [p.id, new Set<string>()]));
  for (const p of people)
    for (const parent of p.parents)
      if (adjacent.has(parent)) {
        adjacent.get(p.id)!.add(parent);
        adjacent.get(parent)!.add(p.id);
      }
  let sweep = new Map(initial);
  for (let pass = 0; pass < 8 && best.crossings; pass++) {
    const down = pass % 2 === 0;
    for (const [y, row] of [...rows].sort(([a], [b]) =>
      down ? a - b : b - a,
    )) {
      const target = (id: string) => {
        const neighbors = [...(adjacent.get(id) || [])]
          .map((id) => sweep.get(id)!)
          .filter((p) => (down ? p.y < y : p.y > y));
        return neighbors.length
          ? neighbors.reduce((s, p) => s + p.x, 0) / neighbors.length
          : sweep.get(id)!.x;
      };
      const blocks = row
        .map((ids) => ({
          members: [...ids].sort((a, b) => target(a) - target(b)),
          target: ids.reduce((s, id) => s + target(id), 0) / ids.length,
          width: ids.length * width + (ids.length - 1) * 32,
        }))
        .sort((a, b) => a.target - b.target);
      const total =
        blocks.reduce((s, block) => s + block.width, 0) +
        (blocks.length - 1) * 64;
      let x =
        blocks.reduce((s, block) => s + block.target, 0) / blocks.length +
        width / 2 -
        total / 2;
      for (const block of blocks) {
        block.members.forEach((id, i) =>
          sweep.set(id, { x: x + i * (width + 32), y }),
        );
        x += block.width + 64;
      }
    }
    const nextPositions: [string, Point][] = initial.map(([id]) => [
      id,
      sweep.get(id)!,
    ]);
    const nextRoutes = routeRelationships(
        people,
        links,
        nextPositions,
        width,
        height,
      ),
      next = score(nextRoutes);
    if (
      next.count >= best.count &&
      (next.crossings < best.crossings ||
        (next.crossings === best.crossings && next.length < best.length))
    ) {
      positions = nextPositions;
      routes = nextRoutes;
      best = next;
    }
    if (pass === 3)
      sweep = new Map(initial.map(([id, p]) => [id, { x: -p.x, y: p.y }]));
  }
  let improved = true;
  const parents = new Map(people.map((p) => [p.id, p.parents]));
  while (improved && best.crossings && attempts < 80) {
    improved = false;
    for (const [, row] of [...rows].sort(([a], [b]) => b - a)) {
      const current = new Map(positions);
      const left = (unit: string[]) =>
        Math.min(...unit.map((id) => current.get(id)!.x));
      const span = (unit: string[]) =>
        Math.max(...unit.map((id) => current.get(id)!.x)) - left(unit) + width;
      const ordered = [...row].sort((a, b) => left(a) - left(b));
      const target = (unit: string[]) => {
        const adjacent = unit
          .flatMap((id) => parents.get(id) || [])
          .map((id) => current.get(id))
          .filter((p): p is Point => !!p);
        return adjacent.length
          ? adjacent.reduce((sum, p) => sum + p.x, 0) / adjacent.length
          : left(unit);
      };
      const gaps = ordered
        .slice(1)
        .map((unit, i) =>
          Math.max(32, left(unit) - left(ordered[i]) - span(ordered[i])),
        );
      const candidates = [[...ordered].sort((a, b) => target(a) - target(b))];
      const priority = ordered
        .map((unit, i) => ({ i, delta: Math.abs(target(unit) - left(unit)) }))
        .sort((a, b) => b.delta - a.delta);
      for (const { i } of priority)
        for (let j = 0; j < ordered.length; j++)
          if (i !== j) {
            const moved = [...ordered];
            moved.splice(j, 0, moved.splice(i, 1)[0]);
            candidates.push(moved);
          }
      for (const swapped of candidates) {
        if (attempts++ >= 80) break;
        if (swapped.every((unit, i) => unit === ordered[i])) continue;
        const candidate = new Map(current);
        let x = left(ordered[0]);
        for (let j = 0; j < swapped.length; j++) {
          const unit = swapped[j],
            start = left(unit);
          for (const id of unit)
            candidate.set(id, {
              ...current.get(id)!,
              x: x + current.get(id)!.x - start,
            });
          x += span(unit) + (gaps[j] || 0);
        }
        const nextPositions: [string, Point][] = initial.map(([id]) => [
          id,
          candidate.get(id)!,
        ]);
        const nextRoutes = routeRelationships(
            people,
            links,
            nextPositions,
            width,
            height,
          ),
          next = score(nextRoutes);
        if (
          next.count >= best.count &&
          (next.crossings < best.crossings ||
            (next.crossings === best.crossings &&
              next.length < best.length * 0.9))
        ) {
          positions = nextPositions;
          routes = nextRoutes;
          best = next;
          improved = true;
        }
      }
      if (!best.crossings || attempts >= 80) break;
    }
  }
  return { positions, routes };
}
