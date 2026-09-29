import test from "node:test";
import assert from "node:assert/strict";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { branchContactCounts } from "../src/domain/union-layout.ts";
import { routeRelationships } from "../src/domain/edge-routing.ts";
import {
  coupleBlocksWithContactedAncestry,
  invertedCoupleBlocks,
  locallyReverseCouples,
} from "../src/domain/local-couple-order.ts";

test("a local couple swap reroutes ancestry without moving the surrounding blocks", () => {
  const geometry: TreeGeometry = {
    mode: "generations",
    reverse: false,
    nodeSize: { width: 220, height: 264 },
    start: 1700,
    offset: 0,
    positions: [
      ["parent-a", { x: 300, y: 0 }],
      ["parent-b", { x: -200, y: 0 }],
      ["A", { x: 0, y: 500 }],
      ["B", { x: 252, y: 500 }],
    ],
    blocks: [
      {
        id: "couple",
        members: ["A", "B"],
        x: 0,
        y: 500,
        width: 472,
        height: 264,
      },
    ],
    branches: [
      {
        id: 'child:"A"',
        source: "parent-a",
        target: "A",
        union: "origin-a",
        relations: [{ from: "parent-a", to: "A", type: "parent" }],
        route: {
          sourceHandle: "bottom",
          targetHandle: "top",
          points: [
            { x: 410, y: 264 },
            { x: 410, y: 380 },
            { x: 110, y: 380 },
            { x: 110, y: 500 },
          ],
        },
      },
      {
        id: 'child:"B"',
        source: "parent-b",
        target: "B",
        union: "origin-b",
        relations: [{ from: "parent-b", to: "B", type: "parent" }],
        route: {
          sourceHandle: "bottom",
          targetHandle: "top",
          points: [
            { x: -90, y: 264 },
            { x: -90, y: 340 },
            { x: 362, y: 340 },
            { x: 362, y: 500 },
          ],
        },
      },
      {
        id: "pair:marriage",
        source: "A",
        target: "B",
        union: "marriage",
        relations: [{ from: "A", to: "B", type: "spouse" }],
        route: {
          sourceHandle: "right",
          targetHandle: "left",
          points: [
            { x: 220, y: 632 },
            { x: 252, y: 632 },
          ],
        },
      },
    ],
    routes: [],
  };
  assert.deepEqual([...invertedCoupleBlocks(geometry, 220)], ["couple"]);
  assert.deepEqual(coupleBlocksWithContactedAncestry(geometry, 220), ["couple"]);
  const improved = locallyReverseCouples(geometry, [], [], {
    width: 220,
    height: 264,
  });
  assert.ok(improved);
  assert.equal(branchContactCounts(geometry.branches!).distinct, 1);
  assert.equal(branchContactCounts(improved.branches!).distinct, 0);
  assert.equal(new Map(improved.positions).get("A")?.x, 252);
  assert.equal(new Map(improved.positions).get("B")?.x, 0);
  assert.equal(new Map(improved.positions).get("parent-a")?.x, 300);
  assert.deepEqual(improved.blocks?.[0].members, ["B", "A"]);
  const marriage = improved.branches!.find(
    (branch) => branch.id === "pair:marriage",
  )!;
  assert.equal(marriage.route.sourceHandle, "left");
  assert.equal(marriage.route.targetHandle, "right");
  assert.deepEqual(geometry.blocks?.[0].members, ["A", "B"]);

  const people = geometry.positions.map(([id]) => ({
    id,
    birth: "",
    parents: [],
    spouses: [],
  }));
  const link = { type: "godparent" as const, from: "A", to: "parent-b" };
  const linked: TreeGeometry = {
    ...geometry,
    occurrences: geometry.positions.map(([id]) => ({
      id,
      personId: id,
      block: id === "A" || id === "B" ? "couple" : id,
    })),
    routes: routeRelationships(
      people,
      [link],
      geometry.positions,
      220,
      264,
      new Set(),
      geometry.branches!.map((branch) => ({
        group: branch.union,
        route: branch.route,
      })),
    ),
  };
  assert.equal(linked.routes?.length, 1);
  const linkedSwap = locallyReverseCouples(linked, people, [link], {
    width: 220,
    height: 264,
  });
  assert.ok(linkedSwap);
  assert.equal(linkedSwap.routes?.length, 1);
  assert.equal(linkedSwap.routes?.[0][1].points[0].x, 362);

  const mirror = (handle: "top" | "bottom" | "left" | "right") =>
    handle === "top" ? "bottom" : handle === "bottom" ? "top" : handle;
  const reverse: TreeGeometry = {
    ...geometry,
    reverse: true,
    positions: geometry.positions.map(([id, point]) => [
      id,
      { ...point, y: 500 - point.y },
    ]),
    blocks: geometry.blocks?.map((block) => ({ ...block, y: 500 - block.y })),
    branches: geometry.branches?.map((branch) => ({
      ...branch,
      route: {
        sourceHandle: mirror(branch.route.sourceHandle),
        targetHandle: mirror(branch.route.targetHandle),
        points: branch.route.points.map((point) => ({
          ...point,
          y: 764 - point.y,
        })),
      },
    })),
  };
  const reverseSwap = locallyReverseCouples(reverse, [], [], {
    width: 220,
    height: 264,
  });
  assert.ok(reverseSwap);
  assert.equal(branchContactCounts(reverseSwap.branches!).distinct, 0);
  assert.equal(
    reverseSwap.branches
      ?.find((branch) => branch.target === "A")
      ?.route.points.at(-1)?.y,
    264,
  );
});

test("contacted ancestry remains eligible without an inverted origin order", () => {
  const geometry: TreeGeometry = {
    mode: "generations", reverse: false, start: 1700, offset: 0,
    positions: [
      ["A", { x: 0, y: 500 }],
      ["B", { x: 252, y: 500 }],
      ["C", { x: 700, y: 500 }],
      ["D", { x: 952, y: 500 }],
    ],
    blocks: [
      { id: "candidate", members: ["A", "B"], x: 0, y: 500, width: 472, height: 264 },
      { id: "untouched", members: ["C", "D"], x: 700, y: 500, width: 472, height: 264 },
    ],
    branches: [
      { id: 'child:"A"', source: "p", target: "A", union: "first", relations: [],
        route: { sourceHandle: "bottom", targetHandle: "top", points: [
          { x: -90, y: 264 }, { x: -90, y: 380 }, { x: 110, y: 380 }, { x: 110, y: 500 },
        ] } },
      { id: 'child:"B"', source: "q", target: "B", union: "second", relations: [],
        route: { sourceHandle: "bottom", targetHandle: "top", points: [
          { x: 500, y: 264 }, { x: 500, y: 450 }, { x: 0, y: 450 }, { x: 0, y: 480 },
          { x: 362, y: 480 }, { x: 362, y: 500 },
        ] } },
    ],
  };
  assert.equal(invertedCoupleBlocks(geometry, 220).size, 0);
  assert.ok(branchContactCounts(geometry.branches!).distinct > 0);
  assert.deepEqual(coupleBlocksWithContactedAncestry(geometry, 220), ["candidate"]);
});
