import test from "node:test";
import assert from "node:assert/strict";
import type { TreeGeometry, LayoutPerson } from "../src/domain/tree-layout.ts";
import type { UnionBranch } from "../src/domain/union-layout.ts";
import { createGeometryContactScorer } from "../src/domain/union-layout.ts";
import {
  mirrorMultiPartnerBlock,
  optimizeMultiPartnerOrder,
} from "../src/domain/multi-partner-order.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";

const size = treeNodeSize();
function fixture(reverse: boolean) {
  const positions: TreeGeometry["positions"] = [
    ["p-left", { x: 0, y: 0 }],
    ["p-right", { x: 504, y: 0 }],
    ["a", { x: 0, y: 500 }],
    ["shared", { x: 252, y: 500 }],
    ["b", { x: 504, y: 500 }],
    ["child-a", { x: 504, y: 1000 }],
    ["child-b", { x: 0, y: 1000 }],
  ];
  const people: LayoutPerson[] = positions.map(([id]) => ({
    id,
    birth: "",
    parents:
      id === "a"
        ? ["p-right"]
        : id === "b"
          ? ["p-left"]
          : id === "child-a"
            ? ["a", "shared"]
            : id === "child-b"
              ? ["b", "shared"]
              : [],
    spouses:
      id === "shared" ? ["a", "b"] : ["a", "b"].includes(id) ? ["shared"] : [],
  }));
  const child = (
    from: string,
    to: string,
    union: string,
    x: number,
    y: number,
    target: number,
    endY: number,
    channel: number,
  ): UnionBranch => ({
    id: `child:${to}`,
    source: from,
    target: to,
    union,
    relations: people
      .find((p) => p.id === to)!
      .parents.map((parent) => ({ from: parent, to, type: "parent" })),
    route: {
      sourceHandle: "bottom",
      targetHandle: "top",
      points: [
        { x, y },
        { x, y: channel },
        { x: target, y: channel },
        { x: target, y: endY },
      ],
    },
  });
  const pair = (
    from: string,
    to: string,
    union: string,
    x: number,
  ): UnionBranch => ({
    id: `pair:${union}`,
    source: from,
    target: to,
    union,
    relations: [{ from, to, type: "spouse" }],
    route: {
      sourceHandle: "right",
      targetHandle: "left",
      points: [
        { x, y: 632 },
        { x: x + 32, y: 632 },
      ],
    },
  });
  const branches = [
    child("p-left", "b", "left-origin", 110, 264, 614, 500, 350),
    child("p-right", "a", "right-origin", 614, 264, 110, 500, 370),
    pair("a", "shared", "a-union", 220),
    pair("shared", "b", "b-union", 472),
    child("a", "child-a", "a-union", 236, 632, 614, 1000, 850),
    child("shared", "child-b", "b-union", 488, 632, 110, 1000, 870),
  ];
  if (reverse) {
    for (const [, point] of positions) point.y = -point.y;
    for (const branch of branches) {
      for (const point of branch.route.points) point.y = size.height - point.y;
      for (const key of ["sourceHandle", "targetHandle"] as const)
        branch.route[key] =
          branch.route[key] === "top"
            ? "bottom"
            : branch.route[key] === "bottom"
              ? "top"
              : branch.route[key];
    }
  }
  const geometry: TreeGeometry = {
    nodeSize: size,
    mode: "generations",
    reverse,
    start: 1700,
    offset: 0,
    positions,
    routes: [],
    branches,
    blocks: [],
    occurrences: positions.map(([id]) => ({
      id,
      personId: id,
      block: ["a", "shared", "b"].includes(id) ? "multi" : id,
    })),
    generationBands: [0, 500, 1000].map((y, level) => ({
      level,
      targetY: reverse ? -y : y,
      minY: (reverse ? -y : y) - 30,
      maxY: (reverse ? -y : y) + 30,
      members: positions
        .filter(([, p]) => p.y === (reverse ? -y : y))
        .map(([id]) => id),
    })),
  };
  return { geometry, people };
}
for (const reverse of [false, true])
  test(`two partners exchange sides without moving the shared person or mixing their children (reverse=${reverse})`, () => {
    const { geometry, people } = fixture(reverse),
      before = structuredClone(geometry);
    const scorer = createGeometryContactScorer(size.width, size.height);
    const score = (g: TreeGeometry) => ({
      ...scorer.quality(g),
      cardHits: scorer.cardContacts(g),
      overlaps: scorer.cardOverlaps(g),
    });
    const after = optimizeMultiPartnerOrder(geometry, people, [], size, score);
    assert.ok(score(after).crossings < score(geometry).crossings);
    assert.equal(score(after).cardHits, 0);
    assert.equal(score(after).overlaps, 0);
    assert.deepEqual(geometry, before);
    const old = new Map(geometry.positions),
      next = new Map(after.positions);
    assert.deepEqual(next.get("shared"), old.get("shared"));
    assert.equal(next.get("a")!.x, old.get("b")!.x);
    assert.equal(next.get("b")!.x, old.get("a")!.x);
    for (const [id, point] of after.positions)
      assert.equal(point.y, old.get(id)!.y);
    for (const b of after.branches!) {
      const prior = geometry.branches!.find((p) => p.id === b.id)!;
      assert.deepEqual(b.relations, prior.relations);
      for (let i = 1; i < b.route.points.length; i++)
        assert.ok(
          b.route.points[i].x === b.route.points[i - 1].x ||
            b.route.points[i].y === b.route.points[i - 1].y,
        );
      if (!b.id.startsWith("child:child-")) continue;
      const pair = after.branches!.find((p) => p.id === `pair:${b.union}`)!;
      assert.equal(
        b.route.points[0].x,
        (pair.route.points[0].x + pair.route.points.at(-1)!.x) / 2,
      );
    }
    assert.deepEqual(
      mirrorMultiPartnerBlock(after, "multi", size)!.positions,
      geometry.positions,
    );
  });
