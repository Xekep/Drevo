import test from "node:test";
import assert from "node:assert/strict";
import { nearbyArrowRanges, ARROW_MOTION_RADIUS, ARROW_MOTION_LIMIT } from "../src/components/tree/spatial-arrow-motion.ts";
import type { SpatialWorld } from "../src/domain/tree-spatial.ts";

test("arrow motion is clipped to the nearby part of a long real parent edge", () => {
  const world: SpatialWorld = {
    points: new Map([
      ["a", { x: -10_000, y: 0, z: 0, angle: 0 }],
      ["b", { x: 10_000, y: 0, z: 0, angle: 0 }],
    ]),
    connections: [{ from: "a", to: "b", type: "partner" }, { from: "a", to: "b", type: "parent" }],
  };
  const before = structuredClone(world);
  const [range] = nearbyArrowRanges(world, { x: 0, y: 0, z: 0 });
  assert.equal(range.index, 0);
  assert.ok(Math.abs(-10_000 + 20_000 * range.from + ARROW_MOTION_RADIUS) < 1e-8);
  assert.ok(Math.abs(-10_000 + 20_000 * range.to - ARROW_MOTION_RADIUS) < 1e-8);
  assert.deepEqual(nearbyArrowRanges(world, { x: 0, y: 0, z: ARROW_MOTION_RADIUS + 1 }), []);
  assert.deepEqual(world, before);
});

test("nearby motion has a fixed budget, nearest-edge ordering and no zero-length arrows", () => {
  const world: SpatialWorld = { points: new Map(), connections: [] };
  for (let i = 0; i < 200; i++) {
    world.points.set(`a${i}`, { x: i * 10, y: -100, z: 0, angle: 0 });
    world.points.set(`b${i}`, { x: i * 10, y: 100, z: 0, angle: 0 });
    world.connections.push({ from: `a${i}`, to: `b${i}`, type: "parent" });
  }
  world.connections.push({ from: "a0", to: "a0", type: "parent" });
  const ranges = nearbyArrowRanges(world, { x: 0, y: 0, z: 0 });
  assert.equal(ranges.length, ARROW_MOTION_LIMIT);
  assert.deepEqual(ranges.map(range => range.index), Array.from({ length: ARROW_MOTION_LIMIT }, (_, i) => i));
  assert.ok(ranges.every(range => range.from >= .12 && range.to <= .88));
});
