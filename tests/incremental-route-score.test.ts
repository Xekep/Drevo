import test from "node:test";
import assert from "node:assert/strict";
import { incrementalRouteScorer } from "../src/domain/incremental-route-score.ts";
import { routingContactScore } from "../src/domain/routing-quality.ts";
import type { EdgeRoute } from "../src/domain/edge-routing.ts";

type Edge = { id: string; group: string; route: EdgeRoute };
const route = (points: { x: number; y: number }[]): EdgeRoute => ({
  sourceHandle: "bottom",
  targetHandle: "top",
  points,
});
function edges(): Edge[] {
  return Array.from({ length: 260 }, (_, i) => ({
    id: `e${i}`,
    group: `family${Math.floor(i / 4)}`,
    route: route([
      { x: (i % 40) * 17, y: 0 },
      { x: (i % 40) * 17, y: 120 },
      { x: ((i * 13) % 40) * 17, y: 120 },
      { x: ((i * 13) % 40) * 17, y: 300 },
    ]),
  }));
}
test("delta route scores exactly match a full scan through local changes and portfolio resets", () => {
  const score = incrementalRouteScorer();
  let current = edges();
  const verify = () =>
    assert.deepEqual(score(current), routingContactScore(current));
  verify();
  verify();
  for (let i = 0; i < 30; i++) {
    const index = (i * 19) % current.length;
    current = current.map((edge, n) =>
      n !== index
        ? edge
        : {
            ...edge,
            route: route(
              edge.route.points.map((point) => ({
                x: point.x + 7,
                y: point.y + (i % 2 ? 0 : 11),
              })),
            ),
          },
    );
    verify();
  }
  current = current.filter((_, i) => i !== 17);
  verify();
  current = [
    ...current,
    {
      id: "added",
      group: "new family",
      route: route([
        { x: 42, y: 0 },
        { x: 42, y: 400 },
      ]),
    },
  ];
  verify();
  current = current.map((edge, i) =>
    i % 3
      ? edge
      : {
          ...edge,
          group: `changed${i}`,
          route: route([...edge.route.points].reverse()),
        },
  );
  verify();
});
test("shared and reversed family buses preserve weighted contacts and T junctions", () => {
  const current = edges();
  const shared = route([
    { x: 0, y: 120 },
    { x: 680, y: 120 },
  ]);
  for (let i = 0; i < 8; i++)
    current[i] = { ...current[i], group: "shared", route: shared };
  const score = incrementalRouteScorer();
  assert.deepEqual(score(current), routingContactScore(current));
  current[9] = {
    ...current[9],
    route: route([
      { x: 680, y: 120 },
      { x: 0, y: 120 },
    ]),
  };
  assert.deepEqual(score(current), routingContactScore(current));
  current[10] = {
    ...current[10],
    route: route([
      { x: 340, y: 120 },
      { x: 340, y: 320 },
    ]),
  };
  assert.deepEqual(score(current), routingContactScore(current));
});

test("fractional coordinates and reordered routes preserve the full scorer's addition order", () => {
  let current = edges().map((edge, i) => ({
    ...edge,
    route: route([
      { x: i / 7, y: 0 },
      { x: i / 7, y: 10.1 },
      { x: 100 + i / 13, y: 10.1 },
      { x: 100 + i / 13, y: 50.3 },
    ]),
  }));
  const score = incrementalRouteScorer();
  assert.deepEqual(score(current), routingContactScore(current));
  current = current.map((edge, i) =>
    i === 112
      ? {
          ...edge,
          route: route(
            edge.route.points.map((point, j) =>
              j < 2 ? point : { ...point, x: point.x + 0.37 },
            ),
          ),
        }
      : edge,
  );
  assert.deepEqual(score(current), routingContactScore(current));
  current = [...current].reverse();
  assert.deepEqual(score(current), routingContactScore(current));
});

test("contact overlays preserve group iteration order after removal and re-insertion without mutating the full anchor", () => {
  const horizontal = (y: number) => route([{ x: 0, y }, { x: 10, y }]);
  const initial: Edge[] = [
    { id: "first", group: "A", route: horizontal(0) },
    { id: "vertical", group: "B", route: route([{ x: 5, y: -5 }, { x: 5, y: 5 }]) },
    { id: "middle", group: "C", route: horizontal(2) },
    { id: "last", group: "A", route: horizontal(4) },
    ...Array.from({ length: 220 }, (_, i) => ({ id: `filler-${i}`, group: `isolated-${i}`,
      route: route([{ x: 1000 + i * 20, y: 1000 }, { x: 1000 + i * 20 + 10, y: 1000 }]) })),
  ];
  const score = incrementalRouteScorer(), anchor = score(initial), snapshot = structuredClone(anchor);
  assert.deepEqual([...anchor.quality.groups.keys()], ["A", "B", "C"]);
  for (const first of [
    { ...initial[0], route: horizontal(10) },
    { ...initial[0], route: horizontal(0) },
  ]) {
    const next = [first, ...initial.slice(1)], result = score(next);
    assert.deepEqual(result, routingContactScore(next));
    assert.deepEqual([...result.quality.groups.keys()], ["B", "C", "A"]);
    assert.deepEqual(anchor, snapshot);
    assert.strictEqual(score(initial), anchor);
  }
  const next = [{ ...initial[0], group: "D" }, ...initial.slice(1)];
  assert.deepEqual(score(next), routingContactScore(next));
  assert.deepEqual([...score(next).quality.groups.keys()], ["B", "C", "A", "D"]);
  assert.deepEqual(anchor, snapshot);
});
