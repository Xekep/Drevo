import type { LayoutPerson } from "./tree-layout.ts";

export type Point = { x: number; y: number };
type Segment = [Point, Point];
/** Только собственное пересечение: общая семейная линия и её развилки допустимы. */
export function segmentsCross([a, b]: Segment, [c, d]: Segment) {
  const turn = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  return (
    turn(a, b, c) * turn(a, b, d) < -0.01 &&
    turn(c, d, a) * turn(c, d, b) < -0.01
  );
}

/** Перебираем порядок семей и супругов, оценивая все родительские ветви. */
export function untangleFamilies(
  people: LayoutPerson[],
  initial: [string, Point][],
  families: string[][],
  width: number,
) {
  let best = new Map(initial.map(([id, p]) => [id, { ...p }]));
  const parents = people
    .filter((p) => p.parents.some((id) => best.has(id)))
    .map((p) => ({
      child: p.id,
      parents: p.parents.filter((id) => best.has(id)),
    }));
  const rows = new Map<number, string[][]>();
  for (const family of families) {
    const y = best.get(family[0])!.y;
    const row = rows.get(y) || [];
    row.push(family);
    rows.set(y, row);
  }
  if (![...rows.values()].some((row) => row.length > 1 || row[0].length > 1))
    return initial;
  const neighbors = new Map(people.map((p) => [p.id, new Set<string>()]));
  for (const p of people)
    for (const parent of p.parents)
      if (neighbors.has(parent)) {
        neighbors.get(p.id)!.add(parent);
        neighbors.get(parent)!.add(p.id);
      }
  // На больших архивах ограничиваем оценку пар, а не глубину родословной.
  const sampled =
    parents.length <= 1200
      ? parents
      : parents.filter((_, i) => i % Math.ceil(parents.length / 1200) === 0);
  const score = (positions: Map<string, Point>) => {
    const edges: Segment[] = sampled.map((p) => {
      const points = p.parents.map((id) => positions.get(id)!);
      return [
        {
          x: points.reduce((s, a) => s + a.x, 0) / points.length,
          y: points.reduce((s, a) => s + a.y, 0) / points.length,
        },
        positions.get(p.child)!,
      ];
    });
    let crossings = 0,
      length = 0;
    for (let i = 0; i < edges.length; i++) {
      length += Math.abs(edges[i][0].x - edges[i][1].x);
      for (let j = 0; j < i; j++)
        if (segmentsCross(edges[i], edges[j])) crossings++;
    }
    return { crossings, length };
  };
  let bestScore = score(best);
  if (!bestScore.crossings) return initial;
  const orderedRows = [...rows].sort(([a], [b]) => a - b);
  let candidate = new Map(best);
  for (let pass = 0; pass < 12; pass++) {
    const down = pass % 2 === 0;
    for (const [y, groups] of down ? orderedRows : [...orderedRows].reverse()) {
      const target = (id: string) => {
        const adjacent = [...neighbors.get(id)!]
          .map((key) => candidate.get(key)!)
          .filter((p) => (down ? p.y < y : p.y > y));
        return adjacent.length
          ? adjacent.reduce((s, p) => s + p.x, 0) / adjacent.length
          : candidate.get(id)!.x;
      };
      const blocks = groups
        .map((ids) => {
          const members = [...ids].sort(
            (a, b) =>
              target(a) - target(b) ||
              candidate.get(a)!.x - candidate.get(b)!.x,
          );
          return {
            members,
            target:
              members.reduce((s, id) => s + target(id), 0) / members.length,
            width: members.length * width + (members.length - 1) * 32,
          };
        })
        .sort((a, b) => a.target - b.target);
      const total =
        blocks.reduce((s, b) => s + b.width, 0) + (blocks.length - 1) * 64;
      let x =
        blocks.reduce((s, b) => s + b.target, 0) / blocks.length +
        width / 2 -
        total / 2;
      for (const block of blocks) {
        block.members.forEach((id, index) =>
          candidate.set(id, { x: x + index * (width + 32), y }),
        );
        x += block.width + 64;
      }
    }
    const next = score(candidate);
    if (
      next.crossings < bestScore.crossings ||
      (next.crossings === bestScore.crossings && next.length < bestScore.length)
    ) {
      best = new Map(candidate);
      bestScore = next;
    }
    if (!bestScore.crossings) break;
    // Вторая стартовая ориентация помогает выйти из симметричного расположения.
    if (pass === 5)
      candidate = new Map(initial.map(([id, p]) => [id, { x: -p.x, y: p.y }]));
  }
  const left = Math.min(...[...best.values()].map((p) => p.x));
  return initial.map(
    ([id]) =>
      [id, { ...best.get(id)!, x: best.get(id)!.x - left }] as [string, Point],
  );
}
