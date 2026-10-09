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
