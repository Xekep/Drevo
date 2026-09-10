import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import { unionGeometry } from "../src/domain/union-layout.ts";
import { unionTimeline } from "../src/domain/union-timeline.ts";
import { routeKey, segmentHitsBox } from "../src/domain/edge-routing.ts";
import { yearY } from "../src/domain/layout.ts";
import { dateYear } from "../src/domain/dates.ts";
import type { LayoutPerson } from "../src/domain/tree-layout.ts";
import type { FamilyLink } from "../src/domain/types.ts";

const person = (
  id: string,
  birth = "",
  parents: string[] = [],
  spouses: string[] = [],
): LayoutPerson => ({ id, birth, parents, spouses });
async function verify(
  people: LayoutPerson[],
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
) {
  const before = structuredClone(people);
  const base = await unionGeometry(
    people,
    (g) => new ELK().layout(g),
    false,
    links,
  );
  const originalBase = structuredClone(base);
  for (const reverse of [false, true]) {
    const g = unionTimeline(people, base, reverse, links);
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
    assert.deepEqual(
      new Set(g.routes!.map(([key]) => key)),
      new Set(links.map(routeKey)),
    );
    for (const block of base.blocks!) {
      const [a, b] = block.members.map((id) => points.get(id)!);
      assert.ok(
        Math.abs(Math.abs(a.x - b.x) - 252) < 0.01,
        "a couple moves together even with unequal dates",
      );
    }
    for (const pair of g.branches!.filter((b) => b.id.startsWith("pair:"))) {
      for (let i = 2; i < pair.route.points.length; i++) {
        const a = pair.route.points[i - 2],
          b = pair.route.points[i - 1],
          c = pair.route.points[i];
        assert.ok(
          (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) >= 0,
          "a pair's route cannot double back through a dead-end junction",
        );
      }
      for (const child of g.branches!.filter(
        (b) => b.union === pair.union && b.id.startsWith("child:"),
      )) {
        const joint = child.route.points[0];
        assert.ok(
          pair.route.points.slice(1).some((b, i) => {
            const a = pair.route.points[i];
            return (
              joint.x >= Math.min(a.x, b.x) - 0.01 &&
              joint.x <= Math.max(a.x, b.x) + 0.01 &&
              joint.y >= Math.min(a.y, b.y) - 0.01 &&
              joint.y <= Math.max(a.y, b.y) + 0.01
            );
          }),
          "children must connect to the actual pair line",
        );
      }
    }
    for (let i = 0; i < g.positions.length; i++)
      for (let j = 0; j < i; j++) {
        const a = g.positions[i][1],
          b = g.positions[j][1];
        assert.ok(
          Math.abs(a.x - b.x) >= 220 || Math.abs(a.y - b.y) >= 96,
          "cards do not overlap",
        );
      }
    for (const branch of [
      ...g.branches!,
      ...g.routes!.map(([id, route]) => ({ id, route })),
    ])
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
  assert.deepEqual(
    base,
    originalBase,
    "chronology cannot alter the generation layout",
  );
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

test("a pair with nearby birth years has one connector and attached children without backtracking", async () => {
  await verify([
    person("mother", "1902", [], ["father"]),
    person("father", "1900"),
    person("one", "1926", ["mother", "father"]),
    person("two", "1931", ["mother", "father"]),
  ]);
});

test("chronology retains references in intermarriage and all additional relationship types", async () => {
  const people = [
    person("a", "1870", [], ["c"]),
    person("b", "1890", ["a"]),
    person("c", "1910", ["b"]),
    person("child", "1932", ["a", "c"]),
    person("godparent", "1905"),
    person("adopter", "1900"),
    person("adopted", "1930"),
    person("guardian", "1895"),
    person("nurse", "1898"),
    person("friend", "1931"),
  ];
  await verify(people, [
    { type: "godparent", from: "godparent", to: "child" },
    { type: "adoptive_parent", from: "adopter", to: "adopted" },
    { type: "guardian", from: "guardian", to: "child" },
    { type: "nurse", from: "nurse", to: "child" },
    { type: "sworn_sibling", from: "child", to: "friend" },
  ]);
});
