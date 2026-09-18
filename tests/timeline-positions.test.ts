import test from "node:test";
import assert from "node:assert/strict";
import {
  timelinePositions,
  type TimelineCard,
} from "../src/domain/timeline-positions.ts";
import { routingQuality } from "../src/domain/routing-quality.ts";

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

test("collision-free placement keeps the horizontal skeleton inherited from the tree", () => {
  const cards: TimelineCard[] = [
    { id: "a", block: "pair", x: 0, y: 0 },
    { id: "b", block: "pair", x: 252, y: 8 },
    { id: "child", block: "child", x: 1500, y: 240 },
    { id: "other", block: "other", x: 3000, y: 200 },
  ];
  const before = structuredClone(cards),
    positions = new Map(timelinePositions(cards));
  for (const card of cards)
    assert.deepEqual(positions.get(card.id), { x: card.x, y: card.y });
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
