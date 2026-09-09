import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import { unionGeometry } from "../src/domain/union-layout.ts";
import { unionTimeline } from "../src/domain/union-timeline.ts";
import { routeKey, segmentHitsBox } from "../src/domain/edge-routing.ts";
import { yearY } from "../src/domain/layout.ts";
import { dateYear } from "../src/domain/dates.ts";
import type { LayoutPerson } from "../src/domain/tree-layout.ts";

const person = (
  id: string,
  birth = "",
  parents: string[] = [],
  spouses: string[] = [],
): LayoutPerson => ({ id, birth, parents, spouses });
async function verify(people: LayoutPerson[]) {
  const before = structuredClone(people);
  const base = await unionGeometry(people, (g) => new ELK().layout(g));
  for (const reverse of [false, true]) {
    const g = unionTimeline(people, base, reverse);
    const points = new Map(g.positions);
    for (const o of g.occurrences!) {
      const p = people.find((p) => p.id === o.personId)!;
      if (p.birth)
        assert.equal(
          points.get(o.id)!.y,
          g.offset + yearY(dateYear(p.birth), g.start, reverse),
        );
      else assert.ok(points.get(o.id)!.y < g.offset);
    }
    assert.equal(
      g.branches!.length,
      base.branches!.length,
      "every union branch is routed",
    );
    const actual = new Set(g.coveredRelations);
    const expected = new Set(
      people.flatMap((p) => [
        ...p.parents.map((from) =>
          routeKey({ from, to: p.id, type: "parent" }),
        ),
        ...p.spouses.map((s) => {
          const [from, to] = [p.id, s].sort();
          return routeKey({ from, to, type: "spouse" });
        }),
      ]),
    );
    assert.deepEqual(actual, expected);
    for (let i = 0; i < g.positions.length; i++)
      for (let j = 0; j < i; j++) {
        const a = g.positions[i][1],
          b = g.positions[j][1];
        assert.ok(
          Math.abs(a.x - b.x) >= 220 || Math.abs(a.y - b.y) >= 96,
          "cards do not overlap",
        );
      }
    for (const branch of g.branches!)
      for (let i = 1; i < branch.route.points.length; i++) {
        const a = branch.route.points[i - 1],
          b = branch.route.points[i];
        assert.ok(a.x === b.x || a.y === b.y);
        for (const [id, p] of g.positions)
          assert.equal(
            segmentHitsBox(a, b, {
              left: p.x,
              right: p.x + 220,
              top: p.y,
              bottom: p.y + 96,
            }),
            false,
            `${branch.id} crosses ${id}, reverse=${reverse}`,
          );
      }
  }
  assert.deepEqual(people, before);
}
test("chronology retains exact years and separate remarriages with undated spouses", async () => {
  await verify([
    person("a", "1900", [], ["b", "c"]),
    person("b", "1907"),
    person("c"),
    person("ab", "1930", ["a", "b"]),
    person("ac", "1940", ["a", "c"]),
  ]);
});
test("chronology groups undated families and never invents a second parent", async () => {
  await verify([
    person("a", "", [], ["b"]),
    person("b"),
    person("one", "", ["a"]),
    person("two", "", ["a", "b"]),
    person("three", "", ["a", "b"]),
  ]);
});
test("chronology routes dense equal-year families around unrelated cards", async () => {
  await verify([
    person("a", "1890", [], ["b"]),
    person("b", "1890"),
    ...Array.from({ length: 12 }, (_, i) =>
      person(`child${i}`, String(1910 + i), ["a", "b"]),
    ),
    ...Array.from({ length: 6 }, (_, i) =>
      person(`other${i}`, String(1912 + i)),
    ),
  ]);
});
test("empty chronology works without fabricated dates", async () => {
  await verify([]);
});
