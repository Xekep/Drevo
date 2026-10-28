import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import { optimizeDisplayedTree } from "../src/domain/optimize-tree-layout.ts";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { treeRowSpan } from "../src/domain/compact-tree-layout.ts";
import {
  crowdedFamily,
  spaceSize as size,
} from "./local-family-space-fixture.ts";
import { person, randomFamily } from "./layout-fixtures.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

test("compaction coordinates unequal generation rows without breaking straight ancestor columns", () => {
  const people = [person("a"), person("b"), person("c"),
    person("aa", ["a"]), person("bb", ["b"]), person("cc", ["c"]), person("cd", ["c"])];
  const points = new Map(people.map((p, i) => [p.id, { x: i < 3 ? i * 2000 : (i - 3) * 2000, y: i < 3 ? 0 : 600 }]));
  const geometry: TreeGeometry = {
    mode: "generations", reverse: false, nodeSize: size, start: 1830, offset: 0,
    positions: [...points], occurrences: people.map(p => ({ id: p.id, personId: p.id, block: p.id })),
    blocks: [], routes: [], siblingGroups: [],
    generationBands: [0, 600].map((y, i) => ({ level: i, targetY: y, minY: y, maxY: y,
      members: people.filter(p => points.get(p.id)!.y === y).map(p => p.id) })),
    branches: people.filter(p => p.parents.length).map(p => {
      const from = p.parents[0], a = points.get(from)!, b = points.get(p.id)!;
      const start = { x: a.x + size.width / 2, y: a.y + size.height };
      const end = { x: b.x + size.width / 2, y: b.y };
      return { id: `child:${p.id}`, source: from, target: p.id, union: `union:${from}`,
        relations: [{ from, to: p.id, type: "parent" as const }],
        route: { sourceHandle: "bottom", targetHandle: "top", points: a.x === b.x ? [start, end]
          : [start, { x: start.x, y: 430 }, { x: end.x, y: 430 }, end] } };
    }),
  };
  const original = structuredClone(geometry);
  const result = optimizeDisplayedTree(geometry, people, [], "compact");
  assert.equal(result.optimization.changed, true);
  assert.ok(treeRowSpan(result.geometry, size) < treeRowSpan(geometry, size));
  for (const id of ["aa", "bb", "cc"]) {
    const route = result.geometry.branches!.find(b => b.target === id)!.route.points;
    assert.equal(route.length, 2, "packing must preserve a straight ancestor column");
    assert.equal(route[0].x, route[1].x);
  }
  assert.deepEqual(geometry, original);
});

for (const reverse of [false, true])
  test(`explicit compact goal closes gaps, retaining partners, sizes and generations (reverse=${reverse})`, () => {
    const { geometry, input } = crowdedFamily(20, 2, reverse);
    const snapshot = structuredClone(geometry),
      people = structuredClone(input.people);
    assert.equal(optimizeDisplayedTree(geometry, people, []).geometry, geometry,
      "ordinary routing optimization must not force compact spacing");
    const result = optimizeDisplayedTree(geometry, people, [], "compact");
    assert.equal(result.optimization.changed, true);
    assert.ok(treeRowSpan(result.geometry, size) < treeRowSpan(geometry, size));
    assert.deepEqual(result.geometry.nodeSize, size);
    assert.deepEqual(result.geometry.occurrences, geometry.occurrences);
    assert.deepEqual(result.geometry.generationBands, geometry.generationBands);
    const positions = new Map(result.geometry.positions);
    for (const [id, p] of geometry.positions)
      assert.equal(positions.get(id)!.y, p.y);
    assert.equal(
      positions.get("neighbor-partner")!.x - positions.get("right-1")!.x,
      252,
    );
    const block = result.geometry.blocks![0];
    assert.equal(block.x, positions.get("right-1")!.x);
    assert.equal(block.width, 472);
    const scorer = createGeometryContactScorer(size.width, size.height);
    assert.equal(scorer.cardContacts(result.geometry), 0);
    assert.equal(scorer.cardOverlaps(result.geometry), 0);
    assert.equal(scorer.quality(result.geometry).crossings, 0);
    assert.deepEqual(geometry, snapshot);
    assert.deepEqual(people, input.people);
    assert.deepEqual(
      optimizeDisplayedTree(geometry, people, [], "compact"),
      result,
    );
  });

test("an already compact scene is an honest no-op and oversized/non-2D projections are rejected", () => {
  const { geometry, input } = crowdedFamily(10);
  const first = optimizeDisplayedTree(geometry, input.people, [], "compact");
  const second = optimizeDisplayedTree(
    first.geometry,
    input.people,
    [],
    "compact",
  );
  assert.equal(second.optimization.changed, false);
  assert.equal(second.geometry, first.geometry);
  assert.throws(
    () =>
      optimizeDisplayedTree(
        { ...geometry, mode: "timeline" },
        input.people,
        [],
        "compact",
      ),
    /2D/,
  );
  const large = crowdedFamily(1601);
  assert.throws(
    () =>
      optimizeDisplayedTree(large.geometry, large.input.people, [], "compact"),
    /1600/,
  );
});

test("connected multi-generation scenes retain all facts and never gain primary collisions", async () => {
  for (const reverse of [false, true]) {
    const people = randomFamily(7, 3),
      elk = new ELK();
    const original = await unionGeometry(
      people,
      (g) => elk.layout(g),
      reverse,
      [],
      size,
    );
    const snapshot = structuredClone(original);
    const result = optimizeDisplayedTree(original, people, [], "compact");
    assert.ok(
      treeRowSpan(result.geometry, size) <= treeRowSpan(original, size),
    );
    assert.deepEqual(result.geometry.occurrences, original.occurrences);
    assert.deepEqual(result.geometry.generationBands, original.generationBands);
    const score = createGeometryContactScorer(size.width, size.height);
    const before = score.quality(original),
      after = score.quality(result.geometry);
    assert.ok(after.crossings <= before.crossings);
    assert.ok(after.contacts <= before.contacts);
    assert.ok(
      score.cardContacts(result.geometry) <= score.cardContacts(original),
    );
    assert.ok(
      score.cardOverlaps(result.geometry) <= score.cardOverlaps(original),
    );
    assert.deepEqual(original, snapshot);
  }
});

test("additional ties are reconnected to compacted endpoints", async () => {
  const people = [person("a"), person("b"), person("c")];
  const links = [{ type: "godparent" as const, from: "a", to: "c" }],
    elk = new ELK();
  const original = await unionGeometry(
    people,
    (g) => elk.layout(g),
    false,
    links,
    size,
  );
  const result = optimizeDisplayedTree(original, people, links, "compact");
  assert.equal(result.optimization.changed, true);
  assert.deepEqual(
    result.geometry.routes!.map(([key]) => key),
    original.routes!.map(([key]) => key),
  );
  const position = new Map(result.geometry.positions),
    route = result.geometry.routes![0][1];
  const touches = (p: { x: number; y: number }, id: string) => {
    const card = position.get(id)!;
    return (
      ((p.x === card.x || p.x === card.x + size.width) &&
        p.y >= card.y &&
        p.y <= card.y + size.height) ||
      ((p.y === card.y || p.y === card.y + size.height) &&
        p.x >= card.x &&
        p.x <= card.x + size.width)
    );
  };
  assert.ok(touches(route.points[0], "a"));
  assert.ok(touches(route.points.at(-1)!, "c"));
});
