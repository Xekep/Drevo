import test from "node:test";
import assert from "node:assert/strict";
import { optimizeBranches } from "../src/domain/branch-routing.ts";
import { segmentContact, segmentHitsBox } from "../src/domain/edge-routing.ts";
import type { UnionBranch } from "../src/domain/union-layout.ts";
import type { Point } from "../src/domain/layout-order.ts";

const branch = (id: string, coords: number[][], union = id): UnionBranch => ({
  id,
  union,
  source: "parent",
  target: "child",
  relations: [{ type: "parent", from: "parent", to: "child" }],
  route: {
    sourceHandle: "bottom",
    targetHandle: "top",
    points: coords.map(([x, y]) => ({ x, y })),
  },
});
const detour = () =>
  branch("child:one", [
    [110, 96],
    [110, 130],
    [-90, 130],
    [-90, 270],
    [410, 270],
    [410, 300],
  ]);
const positions: [string, Point][] = [
  ["parent", { x: 0, y: 0 }],
  ["child", { x: 300, y: 300 }],
];
const distance = (points: Point[]) =>
  points
    .slice(1)
    .reduce(
      (s, p, i) =>
        s + Math.abs(p.x - points[i].x) + Math.abs(p.y - points[i].y),
      0,
    );
function clear(points: Point[], cards = positions) {
  for (let i = 1; i < points.length; i++)
    for (const [, p] of cards)
      assert.equal(
        segmentHitsBox(points[i - 1], points[i], {
          left: p.x,
          top: p.y,
          right: p.x + 220,
          bottom: p.y + 96,
        }),
        false,
      );
}

test("a family detour becomes a short route while preserving ports and genealogical data", () => {
  const original = detour(),
    before = structuredClone(original),
    cards = structuredClone(positions);
  const [result] = optimizeBranches([original], positions, 220, 96);
  assert.equal(distance(result.route.points), 504);
  assert.deepEqual(result.route.points[0], original.route.points[0]);
  assert.deepEqual(result.route.points.at(-1), original.route.points.at(-1));
  assert.equal(result.route.sourceHandle, original.route.sourceHandle);
  assert.equal(result.route.targetHandle, original.route.targetHandle);
  assert.deepEqual(result.relations, original.relations);
  clear(result.route.points);
  assert.deepEqual(original, before);
  assert.deepEqual(positions, cards);
});

test("shortcuts retain a necessary corridor around intervening cards", () => {
  const cards: [string, Point][] = [
    ...positions,
    ["obstacle", { x: 10, y: 155 }],
    ["other-obstacle", { x: 240, y: 155 }],
  ];
  const [result] = optimizeBranches([detour()], cards, 220, 96);
  clear(result.route.points, cards);
  assert.ok(result.route.points.some((p) => p.x < 0));
});

test("a shortcut cannot cross, join or share a neighboring family's line", () => {
  for (const coords of [
    [
      [0, 180],
      [450, 180],
    ],
    [
      [0, 180],
      [110, 180],
    ],
    [
      [110, 155],
      [110, 240],
    ],
  ]) {
    const foreign = branch("pair:other", coords, "other");
    const [result, pair] = optimizeBranches(
      [detour(), foreign],
      positions,
      220,
      96,
    );
    for (let i = 1; i < result.route.points.length; i++)
      assert.equal(
        segmentContact(
          result.route.points[i - 1],
          result.route.points[i],
          foreign.route.points[0],
          foreign.route.points[1],
        ),
        "",
      );
    assert.equal(
      pair,
      foreign,
      "a pair's junction is kept for its attached children",
    );
    clear(result.route.points);
  }
});

test("shortened routes behave symmetrically when the tree is reversed", () => {
  const original = detour();
  const mirror = (p: Point) => ({ x: p.x, y: 600 - p.y });
  const reversed = {
    ...original,
    route: {
      sourceHandle: "top" as const,
      targetHandle: "bottom" as const,
      points: original.route.points.map(mirror),
    },
  };
  const reverseCards: [string, Point][] = positions.map(([id, p]) => [
    id,
    { x: p.x, y: 600 - p.y - 96 },
  ]);
  const [forward] = optimizeBranches([original], positions, 220, 96),
    [backward] = optimizeBranches([reversed], reverseCards, 220, 96);
  assert.deepEqual(backward.route.points, forward.route.points.map(mirror));
  clear(backward.route.points, reverseCards);
});
