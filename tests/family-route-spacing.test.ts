import assert from "node:assert/strict";
import test from "node:test";
import type { EdgeRoute } from "../src/domain/edge-routing.ts";
import { spaceFamilyRoutes } from "../src/domain/family-route-spacing.ts";
import { routingQuality } from "../src/domain/routing-quality.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import type { UnionBranch } from "../src/domain/union-layout.ts";

function branch(union: string, target: string, left: number, right: number, y: number): UnionBranch {
  return { id: `child:${target}`, source: union, target, union,
    relations: [{ from: union, to: target, type: "parent" }],
    route: { sourceHandle: "bottom", targetHandle: "top",
      points: [{ x: left, y: 20 }, { x: left, y }, { x: right, y }, { x: right, y: 180 }] } };
}

type Scene = TreeGeometry & { branches: UnionBranch[] };
const scene = (branches: UnionBranch[]): Scene => ({ mode: "generations", reverse: false, start: 1700,
  offset: 0, nodeSize: { width: 20, height: 20 }, positions: [], branches });
const heights = (geometry: TreeGeometry) => geometry.branches!.map(b => b.route.points[1].y);
const quality = (geometry: TreeGeometry) => routingQuality([
  ...geometry.branches!.map(b => ({ group: b.union, route: b.route })),
  ...(geometry.routes || []).map(([group, route]) => ({ group, route })),
]);

test("different families separate while siblings keep their shared corridor and ports", () => {
  for (const gap of [0, 2]) {
    const original = scene([branch("a", "a1", 0, 100, 100), branch("a", "a2", 0, 160, 100),
      branch("b", "b1", 20, 180, 100 + gap)]);
    const snapshot = structuredClone(original);
    const spaced = spaceFamilyRoutes(original);
    assert.deepEqual(original, snapshot);
    assert.strictEqual(spaced.positions, original.positions);
    const [first, sibling, second] = heights(spaced);
    assert.equal(first, sibling);
    assert.equal(Math.abs(second - first), 20);
    assert.equal(first + second, 200 + gap);
    assert.equal(quality(spaced).length, quality(original).length);
    assert.ok(quality(spaced).contacts <= quality(original).contacts);
    assert.ok(quality(spaced).crossings <= quality(original).crossings);
    spaced.branches!.forEach(({ route, ...metadata }, i) => {
      const { route: before, ...previous } = original.branches[i];
      assert.deepEqual(metadata, previous);
      assert.equal(route.sourceHandle, before.sourceHandle);
      assert.equal(route.targetHandle, before.targetHandle);
      assert.deepEqual(route.points[0], before.points[0]);
      assert.deepEqual(route.points.at(-1), before.points.at(-1));
    });
    assert.strictEqual(spaceFamilyRoutes(spaced), spaced);
  }
});

test("a narrow corridor uses the side clear of cards and avoids new contacts with an extra tie", () => {
  const original = scene([branch("a", "a1", 0, 160, 100), branch("b", "b1", 20, 180, 102)]);
  original.positions.push(["card", { x: 60, y: 80 }]);
  const extra: EdgeRoute = { sourceHandle: "bottom", targetHandle: "top",
    points: [{ x: 80, y: 108 }, { x: 80, y: 150 }] };
  original.routes = [["extra", extra]];
  const spaced = spaceFamilyRoutes(original);
  const [upper, lower] = heights(spaced);
  assert.equal(upper, 100);
  assert.ok(lower > 102 && lower < 108);
  assert.strictEqual(spaced.routes, original.routes);
  assert.equal(quality(spaced).crossings, quality(original).crossings);
  assert.equal(quality(spaced).contacts, quality(original).contacts);
  original.positions.push(["other-card", { x: 90, y: 102 }]);
  assert.strictEqual(spaceFamilyRoutes(original), original);
});

test("separation preserves the layout when mirrored vertically", () => {
  const original = scene([branch("a", "a1", 0, 160, 100), branch("b", "b1", 20, 180, 102)]);
  const mirrored = (geometry: TreeGeometry) => ({ ...geometry, reverse: !geometry.reverse,
    branches: geometry.branches!.map(b => ({ ...b, route: { ...b.route,
      points: b.route.points.map(p => ({ ...p, y: 200 - p.y })) } })) });
  assert.deepEqual(spaceFamilyRoutes(mirrored(original)), mirrored(spaceFamilyRoutes(original)));
});

test("a common route for one family and short or disjoint parallel runs are kept", () => {
  for (const branches of [
    [branch("a", "a1", 0, 160, 100), branch("a", "a2", 0, 180, 100)],
    [branch("a", "a1", 0, 50, 100), branch("b", "b1", 10, 90, 102)],
    [branch("a", "a1", 0, 110, 100), branch("b", "b1", 130, 260, 102)],
  ]) {
    const original = scene(branches);
    assert.strictEqual(spaceFamilyRoutes(original), original);
  }
});
