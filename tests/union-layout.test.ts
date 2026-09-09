import test from "node:test";
import assert from "node:assert/strict";
import {
  familyUnions,
  unionGeometry as calculateUnions,
} from "../src/domain/union-layout.ts";
import ELK from "elkjs/lib/elk.bundled.js";
import type { FamilyLink } from "../src/domain/types.ts";
import { crossingPaths } from "../src/domain/route-crossings.ts";
import { segmentHitsBox } from "../src/domain/edge-routing.ts";
import { segmentsCross } from "../src/domain/layout-order.ts";
import type { LayoutPerson, TreeGeometry } from "../src/domain/tree-layout.ts";
const unionGeometry = (
  people: LayoutPerson[],
  reverse = false,
  links: Pick<FamilyLink, "type" | "from" | "to">[] = [],
) =>
  calculateUnions(
    people,
    (graph) => new ELK({ algorithms: ["layered"] }).layout(graph),
    reverse,
    links,
  );
const person = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): LayoutPerson => ({ id, parents, spouses, birth: "" });
function verify(people: LayoutPerson[], g: TreeGeometry) {
  const occurrences = new Map(g.occurrences!.map((o) => [o.id, o.personId]));
  assert.deepEqual(
    [...new Set(occurrences.values())].sort(),
    people.map((p) => p.id).sort(),
  );
  assert.equal(occurrences.size, g.positions.length);
  const actual = new Set(
    g.branches!.flatMap((b) =>
      b.relations.map((r) => JSON.stringify([r.type, r.from, r.to])),
    ),
  );
  const expected = new Set(
    people.flatMap((p) => [
      ...p.parents.map((from) => JSON.stringify(["parent", from, p.id])),
      ...p.spouses.map((id) =>
        JSON.stringify(["spouse", ...[p.id, id].sort()]),
      ),
    ]),
  );
  assert.deepEqual(actual, expected);
  for (let i = 0; i < g.positions.length; i++)
    for (let j = 0; j < i; j++) {
      const a = g.positions[i][1],
        b = g.positions[j][1];
      assert.ok(
        Math.abs(a.x - b.x) >= 220 || Math.abs(a.y - b.y) >= 96,
        "overlapping cards",
      );
    }
  for (const b of g.branches!) {
    assert.ok(occurrences.has(b.source) && occurrences.has(b.target));
    for (let i = 1; i < b.route.points.length; i++) {
      const a = b.route.points[i - 1],
        c = b.route.points[i];
      assert.ok(a.x === c.x || a.y === c.y, "orthogonal route");
      for (const [id, p] of g.positions)
        assert.equal(
          segmentHitsBox(a, c, {
            left: p.x,
            top: p.y,
            right: p.x + 220,
            bottom: p.y + 96,
          }),
          false,
          `${b.id} crosses card ${id}`,
        );
    }
  }
}
test("three marriages and a former spouse's new family remain four exact unions", async () => {
  const people = [
    person("a", [], ["b", "c", "d"]),
    person("b", [], ["a", "e"]),
    person("c"),
    person("d"),
    person("e"),
    person("ab", ["a", "b"]),
    person("ac", ["a", "c"]),
    person("ad", ["a", "d"]),
    person("be", ["b", "e"]),
  ];
  const before = structuredClone(people);
  assert.equal(familyUnions(people).length, 4);
  for (const reverse of [false, true]) {
    const g = await unionGeometry(people, reverse);
    verify(people, g);
    assert.equal(g.blocks!.length, 4);
    assert.ok(g.blocks!.every((b) => b.members.length === 2));
    assert.equal(g.occurrences!.filter((o) => o.personId === "a").length, 3);
    assert.equal(g.occurrences!.filter((o) => o.personId === "b").length, 2);
  }
  assert.deepEqual(people, before);
});
test("a child with one known parent is not assigned to that parent's marriage", async () => {
  const people = [person("a", [], ["b"]), person("b"), person("child", ["a"])];
  const g = await unionGeometry(people);
  verify(people, g);
  const branch = g.branches!.find((b) =>
    b.relations.some((r) => r.to === "child"),
  )!;
  assert.deepEqual(branch.relations, [
    { from: "a", to: "child", type: "parent" },
  ]);
});
test("shared parent branch has one route per child and no crossing in a nuclear family", async () => {
  const people = [
    person("a"),
    person("b"),
    person("one", ["a", "b"]),
    person("two", ["a", "b"]),
    person("three", ["a", "b"]),
  ];
  const g = await unionGeometry(people);
  verify(people, g);
  const children = g.branches!.filter((b) => b.id.startsWith("child:"));
  assert.equal(children.length, 3);
  assert.ok(children.every((b) => b.relations.length === 2));
  assert.deepEqual(
    children.map((b) => b.route.points[0]),
    Array(3).fill(children[0].route.points[0]),
  );
  for (const a of children)
    for (const b of children)
      if (a !== b)
        for (let i = 1; i < a.route.points.length; i++)
          for (let j = 1; j < b.route.points.length; j++)
            assert.equal(
              segmentsCross(
                [a.route.points[i - 1], a.route.points[i]],
                [b.route.points[j - 1], b.route.points[j]],
              ),
              false,
            );
});
test("unequal ancestry aligns a couple and connects both ancestral families", async () => {
  const people = [
    person("a0"),
    person("a", ["a0"], ["b"]),
    person("b0"),
    person("b1", ["b0"]),
    person("b", ["b1"]),
    person("child", ["a", "b"]),
  ];
  const g = await unionGeometry(people);
  verify(people, g);
  const p = new Map(g.positions);
  assert.equal(p.get("a")!.y, p.get("b")!.y);
  for (const person of people)
    for (const parent of person.parents)
      assert.ok(p.get(person.id)!.y > p.get(parent)!.y);
});
test("a union cycle caused by intermarriage keeps all ancestry through explicit occurrences", async () => {
  const people = [
    person("a", [], ["c"]),
    person("b", ["a"]),
    person("c", ["b"]),
    person("d", ["a", "c"]),
  ];
  const g = await unionGeometry(people);
  verify(people, g);
  assert.ok(g.occurrences!.length > people.length);
});
test("reversed display reflects complete routes and keeps genealogical facts", async () => {
  const people = [person("a"), person("b"), person("c", ["a", "b"])];
  const normal = await unionGeometry(people),
    reverse = await unionGeometry(people, true);
  const maxY = Math.max(...normal.positions.map(([, p]) => p.y));
  assert.deepEqual(
    reverse.positions,
    normal.positions.map(([id, p]) => [id, { x: p.x, y: maxY - p.y }]),
  );
  verify(people, reverse);
});
test("gaps distinguish crossings of separate branches, preserving shared family junctions", () => {
  const route = (points: { x: number; y: number }[]) => ({
    sourceHandle: "bottom" as const,
    targetHandle: "top" as const,
    points,
  });
  const edges = [
    {
      id: "a",
      group: "family1",
      route: route([
        { x: 0, y: 50 },
        { x: 100, y: 50 },
      ]),
    },
    {
      id: "b",
      group: "family2",
      route: route([
        { x: 50, y: 0 },
        { x: 50, y: 100 },
      ]),
    },
  ];
  assert.equal(
    crossingPaths(edges).get("a"),
    "M 0 50 L 45 50 M 55 50 L 100 50",
  );
  assert.equal(
    crossingPaths(edges.map((e) => ({ ...e, group: "same" }))).size,
    0,
  );
});

test("ten thousand generations remain bounded in recursion and retain every child", async () => {
  const people = Array.from({ length: 10000 }, (_, i) =>
    person(`deep-${i}`, i ? [`deep-${i - 1}`] : []),
  );
  const g = await unionGeometry(people);
  assert.equal(
    new Set(g.occurrences!.map((o) => o.personId)).size,
    people.length,
  );
  assert.equal(
    g.branches!.filter((b) => b.id.startsWith("child:")).length,
    people.length - 1,
  );
  assert.ok(
    g.positions.every(([, p]) => Number.isFinite(p.x) && Number.isFinite(p.y)),
  );
});

test("adoption and godparents do not create a biological union or lose their routes", async () => {
  const people = [
    person("a"),
    person("b"),
    person("child", ["a", "b"]),
    person("adopted"),
    person("godparent"),
  ];
  const links = [
    { from: "a", to: "adopted", type: "adoptive_parent" as const },
    { from: "godparent", to: "child", type: "godparent" as const },
  ];
  const before = structuredClone(people);
  const g = await unionGeometry(people, false, links);
  verify(people, g);
  assert.equal(g.routes!.length, 2);
  assert.deepEqual(people, before);
  const points = new Map(g.positions);
  assert.ok(points.get("adopted")!.y > points.get("a")!.y);
});
