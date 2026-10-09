import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { bounds, routeRelationships, segmentHitsBox, Spatial } from "../src/domain/edge-routing.ts";
import { branchContactCounts, unionGeometry } from "../src/domain/union-layout.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import { randomFamily } from "./layout-fixtures.ts";
import {
  adjacentFamilyBlocks,
  locallySwapFamilyBlocks,
} from "../src/domain/local-family-order.ts";

const size = { width: 220, height: 264 };

function geometry(): TreeGeometry {
  return {
    mode: "generations", reverse: false, start: 1700, offset: 0,
    positions: [
      ["P", { x: 390, y: 0 }], ["Q", { x: -210, y: 0 }],
      ["A", { x: 0, y: 500 }], ["B", { x: 252, y: 500 }],
      ["C", { x: 600, y: 500 }], ["D", { x: 852, y: 500 }],
    ],
    occurrences: [
      { id: "P", personId: "P", block: "parent-p" },
      { id: "Q", personId: "Q", block: "parent-q" },
      ...["A", "B"].map((id) => ({ id, personId: id, block: "left" })),
      ...["C", "D"].map((id) => ({ id, personId: id, block: "right" })),
    ],
    blocks: [
      { id: "left", members: ["A", "B"], x: 0, y: 500, width: 472, height: 264 },
      { id: "right", members: ["C", "D"], x: 600, y: 500, width: 472, height: 264 },
    ],
    generationBands: [
      { level: 0, targetY: 0, minY: -30, maxY: 30,
        members: ["P", "Q"] },
      { level: 1, targetY: 500, minY: 470, maxY: 530,
        members: ["A", "B", "C", "D"] },
    ],
    branches: [
      { id: "pair:left", source: "A", target: "B", union: "left", relations: [],
        route: { sourceHandle: "right", targetHandle: "left",
          points: [{ x: 220, y: 632 }, { x: 252, y: 632 }] } },
      { id: "pair:right", source: "C", target: "D", union: "right", relations: [],
        route: { sourceHandle: "right", targetHandle: "left",
          points: [{ x: 820, y: 632 }, { x: 852, y: 632 }] } },
      { id: 'child:"A"', source: "P", target: "A", union: "origin-a", relations: [],
        route: { sourceHandle: "bottom", targetHandle: "top", points: [
          { x: 500, y: 264 }, { x: 500, y: 380 },
          { x: 110, y: 380 }, { x: 110, y: 500 },
        ] } },
      { id: 'child:"C"', source: "Q", target: "C", union: "origin-c", relations: [],
        route: { sourceHandle: "bottom", targetHandle: "top", points: [
          { x: -100, y: 264 }, { x: -100, y: 360 },
          { x: 710, y: 360 }, { x: 710, y: 500 },
        ] } },
    ],
    routes: [],
  };
}

test("adjacent equal-width families exchange slots and reconnect their branches", () => {
  const original = geometry();
  assert.ok(adjacentFamilyBlocks(original, size).some(
    ([left, right]) => left === "left" && right === "right"));
  const swapped = locallySwapFamilyBlocks(original, "left", "right", [], [], size);
  assert.ok(swapped);
  const positions = new Map(swapped.positions);
  assert.equal(positions.get("A")?.x, 600);
  assert.equal(positions.get("B")?.x, 852);
  assert.equal(positions.get("C")?.x, 0);
  assert.equal(positions.get("D")?.x, 252);
  assert.equal(positions.get("P")?.x, 390);
  assert.equal(swapped.blocks?.find((block) => block.id === "left")?.x, 600);
  assert.equal(swapped.branches?.find((branch) => branch.id === "pair:left")
    ?.route.points[0].x, 820);
  assert.equal(swapped.branches?.find((branch) => branch.target === "A")
    ?.route.points.at(-1)?.x, 710);
  assert.equal(swapped.branches?.find((branch) => branch.target === "C")
    ?.route.points.at(-1)?.x, 110);
  for (const branch of swapped.branches || [])
    for (let i = 1; i < branch.route.points.length; i++) {
      const a = branch.route.points[i - 1], b = branch.route.points[i];
      assert.ok(a.x === b.x || a.y === b.y);
    }
  assert.equal(new Map(original.positions).get("A")?.x, 0);
  assert.equal(original.branches?.find((branch) => branch.target === "A")
    ?.route.points.at(-1)?.x, 110);
});

test("family exchange reroutes an additional link touching a moved person", () => {
  const original = geometry();
  const people = original.positions.map(([id]) => ({
    id, birth: "", parents: [], spouses: [],
  }));
  const link = { type: "godparent" as const, from: "A", to: "P" };
  original.routes = routeRelationships(people, [link], original.positions,
    size.width, size.height, new Set(),
    original.branches!.map((branch) => ({ group: branch.union, route: branch.route })));
  const swapped = locallySwapFamilyBlocks(original, "left", "right", people,
    [link], size);
  assert.ok(swapped);
  assert.equal(swapped.routes?.length, original.routes.length);
  assert.notDeepEqual(swapped.routes, original.routes);
});

test("a couple and a single person exchange space while preserving the gap and generation", () => {
  const original = geometry();
  original.positions = original.positions.filter(([id]) => id !== "D");
  original.occurrences = original.occurrences!.filter((item) => item.id !== "D");
  original.blocks![1] = { ...original.blocks![1], members: ["C"], width: size.width };
  original.generationBands![1].members = ["A", "B", "C"];
  original.branches = original.branches!.filter((branch) => branch.id !== "pair:right");
  const swapped = locallySwapFamilyBlocks(original, "left", "right", [], [], size);
  assert.ok(swapped);
  const before = new Map(original.positions), after = new Map(swapped.positions);
  assert.equal(branchContactCounts(original.branches || []).distinct, 1);
  assert.equal(branchContactCounts(swapped.branches || []).distinct, 0);
  assert.equal(after.get("C")!.x, 0);
  assert.equal(after.get("A")!.x, 348);
  assert.equal(after.get("B")!.x, 600);
  assert.equal(after.get("A")!.x - after.get("C")!.x - size.width, 128);
  assert.equal(after.get("B")!.x + size.width, before.get("C")!.x + size.width);
  for (const [id, point] of after) assert.equal(point.y, before.get(id)!.y);
  assert.deepEqual(after.get("P"), before.get("P"));
  assert.deepEqual(after.get("Q"), before.get("Q"));
  assert.deepEqual(swapped.generationBands, original.generationBands);
  for (const branch of swapped.branches!) {
    if (branch.id.startsWith("child:"))
      assert.equal(branch.route.points.at(-1)!.x, after.get(branch.target)!.x + size.width / 2);
    for (let i = 1; i < branch.route.points.length; i++) {
      const a = branch.route.points[i - 1], b = branch.route.points[i];
      assert.ok(a.x === b.x || a.y === b.y);
    }
  }
  assert.equal(before.get("A")!.x, 0);
});

test("slot exchanges reject different generations and nonadjacent blocks", () => {
  const original = geometry();
  assert.equal(locallySwapFamilyBlocks(original, "parent-q", "left", [], [], size), undefined);
  original.positions.push(["E", { x: 485, y: 500 }]);
  original.occurrences!.push({ id: "E", personId: "E", block: "middle" });
  original.generationBands![1].members.push("E");
  assert.equal(locallySwapFamilyBlocks(original, "left", "right", [], [], size), undefined);
});

test("cold equal-width family order stays stable for subsequent edits without new ELK passes", async () => {
  const people = randomFamily(1, 4);
  const engine = new ELK({ algorithms: ["layered"] });
  let calls = 0;
  const result = await unionGeometry(people, (graph) => {
    calls++;
    return engine.layout(graph);
  }, false, [], treeNodeSize());
  assert.equal(calls, 7);
  assert.equal(result.positions.length, people.length);
  // Moving these equal-width blocks reduced fresh contacts but degraded the ancestor edit.
  assert.equal(branchContactCounts(result.branches || []).distinct, 217);
});

test("mixed single-parent and couple households improve the cold layout in both directions", async () => {
  const people = randomFamily(8, 3);
  const left = people.find((person) => person.id === "f-4")!;
  const right = people.find((person) => person.id === "f-5")!;
  left.spouses = [];
  right.spouses = [];
  people.filter((person) => person.parents.includes(left.id) && person.parents.includes(right.id))
    .forEach((person, index) => { person.parents = [index % 2 ? left.id : right.id]; });
  const original = structuredClone(people);
  for (const reverse of [false, true]) {
    const engine = new ELK({ algorithms: ["layered"] });
    let calls = 0;
    const result = await unionGeometry(people, (graph) => {
      calls++;
      return engine.layout(graph);
    }, reverse, [], treeNodeSize());
    assert.equal(calls, 7);
    assert.equal(result.positions.length, people.length);
    // The previous layout has 30 contacts. Mixed-width moves remove a crossing.
    assert.ok(branchContactCounts(result.branches || []).distinct < 30);
    assert.deepEqual(people, original);
  }
});

test("large generation layout keeps routed blocks valid in both directions", async () => {
  const people = randomFamily(1, 5);
  for (const reverse of [false, true]) {
    const engine = new ELK({ algorithms: ["layered"] });
    const result = await unionGeometry(people, (graph) => engine.layout(graph),
      reverse, [], treeNodeSize());
    assert.equal(result.positions.length, people.length);
    assert.equal(branchContactCounts(result.branches || []).distinct, 487);
    const cards = new Spatial<{ left: number; right: number; top: number; bottom: number }>();
    for (const [, point] of result.positions) {
      const box = { left: point.x, right: point.x + size.width,
        top: point.y, bottom: point.y + size.height };
      for (const other of cards.query(box))
        assert.ok(box.left >= other.right || box.right <= other.left ||
          box.top >= other.bottom || box.bottom <= other.top);
      cards.add(box);
    }
    for (const branch of result.branches || [])
      for (let i = 1; i < branch.route.points.length; i++) {
        const a = branch.route.points[i - 1], b = branch.route.points[i];
        assert.ok(a.x === b.x || a.y === b.y);
        for (const card of cards.query(bounds(a, b)))
          assert.equal(segmentHitsBox(a, b, card), false);
      }
  }
});
