import test from "node:test";
import assert from "node:assert/strict";
import { incrementalCardContacts } from "../src/domain/incremental-card-contacts.ts";
import {
  bounds,
  segmentHitsBox,
  type EdgeRoute,
} from "../src/domain/edge-routing.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

const route = (points: { x: number; y: number }[]): EdgeRoute => ({
  sourceHandle: "bottom",
  targetHandle: "top",
  points,
});
function fixture(): TreeGeometry {
  return {
    mode: "generations",
    reverse: false,
    start: 0,
    offset: 0,
    positions: Array.from({ length: 260 }, (_, i) => [
      `p${i}`,
      { x: (i % 20) * 300 + 0.1, y: Math.floor(i / 20) * 360 },
    ]),
    routes: Array.from({ length: 260 }, (_, i) => [
      `r${i}`,
      route([
        { x: i * 17.7, y: 0 },
        { x: i * 17.7, y: 1200 },
        { x: i * 11.3, y: 1200 },
        { x: i * 11.3, y: 2000 },
      ]),
    ]),
  };
}
// Brute-force route/card oracle, independent of Spatial and delta accounting.
function full(geometry: TreeGeometry, width = 220, height = 264) {
  let count = 0;
  for (const route of [
    ...geometry.routes!.map(([, r]) => r),
    ...(geometry.branches || []).map((b) => b.route),
  ])
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1],
        b = route.points[i],
        box = bounds(a, b);
      for (const [, p] of geometry.positions) {
        const card = {
          left: p.x,
          right: p.x + width,
          top: p.y,
          bottom: p.y + height,
        };
        if (
          box.left <= card.right &&
          box.right >= card.left &&
          box.top <= card.bottom &&
          box.bottom >= card.top &&
          segmentHitsBox(a, b, card)
        )
          count++;
      }
    }
  return count;
}

test("card deltas match a full scan across independent local candidates, shared routes and resets", () => {
  const score = incrementalCardContacts(220, 264);
  const initial = fixture(),
    original = structuredClone(initial);
  const verify = (geometry: TreeGeometry) =>
    assert.equal(score(geometry), full(geometry));
  verify(initial);
  verify(initial);
  for (let i = 0; i < 48; i++) {
    const geometry: TreeGeometry = {
      ...initial,
      positions: initial.positions.map(([id, p], index) => [
        id,
        index === i ? { x: p.x - 31.1, y: p.y + 17 } : p,
      ]),
      routes: initial.routes!.map(([id, r], index) => [
        id,
        index === (i * 3) % 260
          ? route(r.points.map((p) => ({ x: p.x + 19.3, y: p.y + 0.1 })))
          : r,
      ]),
    };
    verify(geometry);
    verify(initial);
  }
  // Routes-only, boxes-only, reordered routes, diagonal input and degenerate segments.
  const changed = {
    ...initial,
    routes: initial.routes!.map(([id, r], i): [string, EdgeRoute] => [
      id,
      i === 0
        ? route([
            { x: 0, y: 0 },
            { x: 600, y: 600 },
            { x: 600, y: 600 },
          ])
        : r,
    ]),
  };
  verify(changed);
  verify({ ...changed, positions: [...changed.positions].reverse() });
  verify({ ...initial, routes: [...initial.routes!].reverse() });
  verify(initial);
  const shared = {
    ...initial,
    routes: initial.routes!.map(([id, r], i): [string, EdgeRoute] => [
      id,
      i < 5 ? initial.routes![0][1] : r,
    ]),
  };
  verify(shared);
  verify({ ...shared, routes: shared.routes.slice(1) });
  verify({ ...initial, positions: initial.positions.slice(1) });
  verify(initial);
  assert.deepEqual(initial, original);
});

test("duplicate card IDs retain full multiplicity and cannot become a unique delta anchor", () => {
  const score = incrementalCardContacts(220, 264),
    initial = fixture();
  const duplicated = {
    ...initial,
    positions: [...initial.positions, initial.positions[0]],
  };
  assert.equal(score(duplicated), full(duplicated));
  const changed = {
    ...initial,
    positions: initial.positions.map(
      ([id, p], i): TreeGeometry["positions"][number] => [
        id,
        i === 0 ? { ...p, x: p.x + 20 } : p,
      ],
    ),
  };
  assert.equal(score(changed), full(changed));
  assert.equal(score(duplicated), full(duplicated));
});

test("primary and additional routes both contribute, and boundary-only touches do not hit cards", () => {
  const geometry = fixture(),
    score = incrementalCardContacts(220, 264);
  const primary = geometry
    .routes!.slice(0, 2)
    .map(([id, route]) => ({
      id,
      route,
      union: id,
      source: "p0",
      target: "p1",
      relations: [],
    }));
  const mixed = { ...geometry, branches: primary };
  assert.equal(score(mixed), full(mixed));
  const changed = {
    ...mixed,
    branches: primary.map((b) => ({
      ...b,
      route: route(b.route.points.map((p) => ({ ...p, x: 0.1 }))),
    })),
  };
  assert.equal(score(changed), full(changed));
});
