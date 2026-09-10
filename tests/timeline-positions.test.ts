import test from "node:test";
import assert from "node:assert/strict";
import {
  timelinePositions,
  relaxTimelineCards,
  type TimelineCard,
} from "../src/domain/timeline-positions.ts";
import { routingQuality } from "../src/domain/routing-quality.ts";
import type { UnionBranch } from "../src/domain/union-layout.ts";

test("collision resolution preserves both members of a dated/undated union and its clear connecting corridor", () => {
  const cards: TimelineCard[] = [
    { id: "a", block: "pair", x: 0, y: 0 },
    { id: "b", block: "pair", x: 252, y: 800 },
    { id: "obstacle", block: "other", x: 140, y: 300 },
    { id: "left", block: "other-pair", x: 0, y: 800 },
    { id: "right", block: "other-pair", x: 252, y: 820 },
  ];
  const before = structuredClone(cards),
    positions = new Map(timelinePositions(cards));
  assert.equal(positions.size, cards.length);
  for (const p of cards) assert.equal(positions.get(p.id)!.y, p.y);
  for (const [a, b] of [
    ["a", "b"],
    ["left", "right"],
  ])
    assert.equal(positions.get(b)!.x - positions.get(a)!.x, 252);
  const corridor = positions.get("a")!.x + 236,
    obstacle = positions.get("obstacle")!;
  assert.ok(
    corridor <= obstacle.x || corridor >= obstacle.x + 220,
    "other cards cannot occupy the pair's vertical connector",
  );
  const points = [...positions.values()];
  for (let i = 0; i < points.length; i++)
    for (let j = 0; j < i; j++)
      assert.ok(
        Math.abs(points[i].x - points[j].x) >= 220 ||
          Math.abs(points[i].y - points[j].y) >= 96,
      );
  assert.deepEqual(cards, before);
});

test("horizontal relaxation follows known family branches without changing dates or spacing within a pair", () => {
  const cards: TimelineCard[] = [
    { id: "a", block: "pair", x: 0, y: 0 },
    { id: "b", block: "pair", x: 252, y: 8 },
    { id: "child", block: "child", x: 1500, y: 240 },
    { id: "other", block: "other", x: 3000, y: 200 },
  ];
  const branch: UnionBranch = {
    id: "child:one",
    union: "pair",
    source: "a",
    target: "child",
    relations: [
      { type: "parent", from: "a", to: "child" },
      { type: "parent", from: "b", to: "child" },
    ],
    route: {
      sourceHandle: "bottom",
      targetHandle: "top",
      points: [
        { x: 236, y: 56 },
        { x: 236, y: 150 },
        { x: 1610, y: 150 },
        { x: 1610, y: 240 },
      ],
    },
  };
  const before = structuredClone(cards),
    result = relaxTimelineCards(cards, [branch]),
    map = new Map(result.map((p) => [p.id, p]));
  assert.ok(map.get("a")!.x > 0 && map.get("child")!.x < 1500);
  assert.equal(map.get("b")!.x - map.get("a")!.x, 252);
  assert.equal(map.get("other")!.x, 3000);
  assert.deepEqual(
    result.map((p) => p.y),
    cards.map((p) => p.y),
  );
  assert.deepEqual(cards, before);
});

test("routing quality distinguishes unrelated T-junctions and counts a shared family rail once", () => {
  const edge = (group: string, coords: number[][]) => ({
    group,
    route: {
      sourceHandle: "bottom" as const,
      targetHandle: "top" as const,
      points: coords.map(([x, y]) => ({ x, y })),
    },
  });
  const rail = edge("family", [
      [0, 50],
      [100, 50],
    ]),
    cross = edge("other", [
      [50, 0],
      [50, 100],
    ]),
    touch = edge("third", [
      [75, 0],
      [75, 50],
    ]);
  const normal = routingQuality([rail, cross, touch]);
  const repeated = routingQuality([...Array(5).fill(rail), cross, touch]);
  assert.equal(normal.contacts, 2);
  assert.equal(normal.crossings, 1);
  assert.equal(repeated.contacts, normal.contacts);
  assert.equal(repeated.crossings, normal.crossings);
  assert.equal(
    routingQuality([
      rail,
      { ...cross, group: "family" },
      { ...touch, group: "family" },
    ]).contacts,
    0,
  );
});
