import {
  bounds,
  segmentContact,
  segmentHitsBox,
  simplifyRoute,
  Spatial,
  type Box,
} from "./edge-routing.ts";
import type { Point } from "./layout-order.ts";
import type { UnionBranch } from "./union-layout.ts";

type Segment = Box & { a: Point; b: Point; branch: UnionBranch };
const direction = (a: Point, b: Point) =>
  [Math.sign(b.x - a.x), Math.sign(b.y - a.y)].join(":");
const length = (a: Point, b: Point) =>
  Math.abs(b.x - a.x) + Math.abs(b.y - a.y);
const cost = (points: Point[]) =>
  points
    .slice(1)
    .reduce(
      (sum, b, i) => sum + length(points[i], b),
      Math.max(0, points.length - 2) * 16,
    );

/** Убираем обходы между существующими поворотами без сдвига карточек и новых пересечений. */
export function optimizeBranches(
  branches: UnionBranch[],
  positions: [string, Point][],
  width: number,
  height: number,
) {
  const cards = new Spatial<Box>(),
    lines = new Spatial<Segment>();
  const current = new Map(branches.map((b) => [b.id, b]));
  for (const [, p] of positions)
    cards.add({
      left: p.x - 8,
      right: p.x + width + 8,
      top: p.y - 8,
      bottom: p.y + height + 8,
    });
  const index = (branch: UnionBranch) => {
    const points = branch.route.points;
    for (let i = 1; i < points.length; i++)
      if (length(points[i - 1], points[i]))
        lines.add({
          ...bounds(points[i - 1], points[i]),
          a: points[i - 1],
          b: points[i],
          branch,
        });
  };
  branches.forEach(index);
  const conflicts = (points: Point[], branch: UnionBranch) => {
    const result = new Map<string, Set<string>>();
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      for (const line of lines.query(bounds(a, b))) {
        if (
          line.branch.union === branch.union ||
          current.get(line.branch.id) !== line.branch
        )
          continue;
        const key = segmentContact(a, b, line.a, line.b);
        if (key) {
          const set = result.get(line.branch.id) || new Set<string>();
          set.add(key);
          result.set(line.branch.id, set);
        }
      }
    }
    return result;
  };
  const clear = (points: Point[]) => {
    // Вход и выход остаются перпендикулярными карточке; первые 8 px — её отступ.
    const trimmed = points.map((p) => ({ ...p }));
    for (const [i, j] of [
      [0, 1],
      [trimmed.length - 1, trimmed.length - 2],
    ]) {
      const a = trimmed[i],
        b = trimmed[j];
      if (length(a, b) < 8) return false;
      a.x += Math.sign(b.x - a.x) * 8;
      a.y += Math.sign(b.y - a.y) * 8;
    }
    for (let i = 1; i < trimmed.length; i++) {
      const a = trimmed[i - 1],
        b = trimmed[i];
      if (cards.query(bounds(a, b)).some((box) => segmentHitsBox(a, b, box)))
        return false;
    }
    return true;
  };
  for (const branch of branches) {
    // Линия пары содержит точку, к которой подключены дети: её не срезаем.
    if (!branch.id.startsWith("child:")) continue;
    let best = simplifyRoute(branch.route.points);
    if (best.length < 4) continue;
    const source = direction(best[0], best[1]),
      target = direction(best.at(-2)!, best.at(-1)!);
    let score = cost(best);
    const before = conflicts(best, branch);
    for (let pass = 0; pass < 4; pass++) {
      let next = best;
      for (let i = 0; i < best.length - 2; i++)
        for (let j = i + 2; j < best.length; j++) {
          const a = best[i],
            b = best[j];
          for (const turn of [
            { x: a.x, y: b.y },
            { x: b.x, y: a.y },
          ]) {
            const candidate = simplifyRoute([
              ...best.slice(0, i + 1),
              turn,
              ...best.slice(j),
            ]);
            const value = cost(candidate);
            if (
              value >= score - 1 ||
              candidate.length < 2 ||
              direction(candidate[0], candidate[1]) !== source ||
              direction(candidate.at(-2)!, candidate.at(-1)!) !== target ||
              !clear(candidate)
            )
              continue;
            const after = conflicts(candidate, branch);
            if (
              [...after].some(
                ([id, intersections]) =>
                  intersections.size > (before.get(id)?.size || 0),
              )
            )
              continue;
            next = candidate;
            score = value;
          }
        }
      if (next === best) break;
      best = next;
    }
    const updated = { ...branch, route: { ...branch.route, points: best } };
    current.set(branch.id, updated);
    index(updated);
  }
  return branches.map((b) => current.get(b.id)!);
}
