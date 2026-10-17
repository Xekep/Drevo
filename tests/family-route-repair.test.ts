import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { repairFamilyRoutes, FAMILY_ROUTE_REPAIR_LIMITS } from "../src/domain/family-route-repair.ts";
import { createGeometryContactScorer, unionGeometry, type UnionBranch } from "../src/domain/union-layout.ts";
import { randomFamily, editedAncestorFamily } from "./layout-fixtures.ts";

const size = { width: 220, height: 264 };
function scoreFor(nodeSize = size) {
  const s = createGeometryContactScorer(nodeSize.width, nodeSize.height);
  return (g: TreeGeometry) => ({ ...s.quality(g), cardHits: s.cardContacts(g), overlaps: s.cardOverlaps(g) });
}
function layers(reverse: boolean, layerCount = 3): TreeGeometry {
  const positions: TreeGeometry["positions"] = [], branches: UnionBranch[] = [];
  for (let layer = 0; layer < layerCount; layer++) for (let family = 0; family < 10; family++) {
    const x = family * 2000, y = layer * 1200, id = `${layer}-${family}`;
    const p = `P${id}`, q = `Q${id}`, a = `A${id}`, b = `B${id}`;
    positions.push([p, { x: x + 300, y }], [q, { x: x - 200, y }],
      [a, { x, y: y + 500 }], [b, { x: x + 252, y: y + 500 }]);
    for (const [source, target, start, end, lane] of [[p, a, x + 410, x + 110, y + 380], [q, b, x - 90, x + 362, y + 340]] as const)
      branches.push({ id: `child:${target}`, source, target, union: source,
        relations: [{ from: source, to: target, type: "parent" }],
        route: { sourceHandle: "bottom", targetHandle: "top", points: [
          { x: start, y: y + 264 }, { x: start, y: lane }, { x: end, y: lane }, { x: end, y: y + 500 },
        ] } });
  }
  const ys = [...new Set(positions.map(([, p]) => p.y))].sort((a, b) => a - b);
  const generationBands = ys.map((y, level) => ({ level, targetY: y, minY: y - 30, maxY: y + 30,
    members: positions.filter(([, p]) => p.y === y).map(([id]) => id) }));
  if (reverse) {
    for (const [, p] of positions) p.y = -p.y;
    for (const branch of branches) {
      branch.route.sourceHandle = "top";
      branch.route.targetHandle = "bottom";
      for (const p of branch.route.points) p.y = size.height - p.y;
    }
    for (const band of generationBands) {
      const min = band.minY;
      band.targetY = -band.targetY;
      band.minY = -band.maxY;
      band.maxY = -min;
    }
  }
  return { mode: "generations", reverse, start: 1700, offset: 0, nodeSize: size, positions, generationBands,
    branches, occurrences: positions.map(([id]) => ({ id, personId: id, block: id })), routes: [] };
}
for (const reverse of [false, true]) {
  test(`route repair shares a hard budget across actual source generations (reverse=${reverse})`, () => {
    const original = layers(reverse), saved = structuredClone(original), score = scoreFor();
    assert.equal(score(original).crossings, 30);
    const limited = repairFamilyRoutes(original, size, score, 7);
    assert.equal(limited.attempts, 7);
    assert.deepEqual([...limited.byGeneration], [[0, 3], [2, 2], [4, 2]]);
    const result = repairFamilyRoutes(original, size, score, 100);
    assert.equal(result.attempts, FAMILY_ROUTE_REPAIR_LIMITS.candidates);
    assert.deepEqual([...result.byGeneration.values()], [12, 12, 12]);
    assert.ok([...result.byGeneration.values()].every((n) => n <= FAMILY_ROUTE_REPAIR_LIMITS.perGeneration));
    const fourLayers = repairFamilyRoutes(layers(reverse, 4), size, scoreFor());
    assert.equal(fourLayers.attempts, FAMILY_ROUTE_REPAIR_LIMITS.candidates);
    assert.deepEqual([...fourLayers.byGeneration.values()], [9, 9, 9, 9]);
    assert.strictEqual(result.geometry.positions, original.positions);
    assert.strictEqual(result.geometry.occurrences, original.occurrences);
    assert.strictEqual(result.geometry.generationBands, original.generationBands);
    assert.ok(score(result.geometry).crossings <= score(original).crossings);
    assert.ok(score(result.geometry).contacts <= score(original).contacts);
    assert.equal(score(result.geometry).cardHits, 0);
    assert.equal(score(result.geometry).overlaps, 0);
    for (const b of result.geometry.branches!) {
      const before = original.branches!.find((old) => old.id === b.id)!;
      assert.deepEqual(b.route.points[0], before.route.points[0]);
      assert.deepEqual(b.route.points.at(-1), before.route.points.at(-1));
      assert.deepEqual(b.relations, before.relations);
      assert.equal(b.union, before.union);
    }
    assert.deepEqual(original, saved);
    assert.equal(repairFamilyRoutes(original, size, score, 0).attempts, 0);
    const large = { ...original, positions: [...original.positions] };
    while (large.positions.length <= FAMILY_ROUTE_REPAIR_LIMITS.people)
      large.positions.push([`isolated-${large.positions.length}`, { x: large.positions.length * 300, y: 10000 }]);
    const skipped = repairFamilyRoutes(large, size, score);
    assert.equal(skipped.attempts, 0);
    assert.strictEqual(skipped.geometry, large);
  });
}

function drift(before: TreeGeometry, after: TreeGeometry) {
  const old = new Map(before.positions), xs = after.positions.filter(([id]) => old.has(id))
    .map(([id, p]) => p.x - old.get(id)!.x).sort((a, b) => a - b), center = xs[Math.floor(xs.length / 2)];
  return xs.reduce((sum, x) => sum + Math.abs(x - center), 0) / xs.length;
}
for (const height of [84, 264]) {
  test(`historical routes catch up with the improved cold layout without another solver (height=${height})`, async () => {
    const nodeSize = { width: 220, height }, engine = new ELK({ algorithms: ["layered"] }),
      people = randomFamily(1, 4), edited = editedAncestorFamily(people, 1), score = scoreFor(nodeSize);
    const calculate = async (family: typeof people, previous?: TreeGeometry) => {
      let calls = 0;
      const geometry = await unionGeometry(family, (graph) => { calls++; return engine.layout(graph); }, false, [], nodeSize, previous);
      assert.ok(calls <= (previous ? 8 : 7));
      return geometry;
    };
    const before = await calculate(people), saved = structuredClone(before),
      plain = await calculate(edited), after = await calculate(edited, before), next = score(after), fresh = score(plain);
    assert.ok(next.contacts <= fresh.contacts);
    assert.ok(next.crossings <= fresh.crossings);
    assert.ok(next.length <= fresh.length * 1.15);
    assert.ok(next.bends <= fresh.bends * 1.15 + 2);
    assert.equal(next.cardHits, 0);
    assert.equal(next.overlaps, 0);
    assert.ok(drift(before, after) < drift(before, plain) * 0.2);
    assert.deepEqual(new Set(after.occurrences!.map((o) => o.personId)), new Set(edited.map((p) => p.id)));
    assert.deepEqual(after.nodeSize, nodeSize);
    assert.deepEqual(before, saved);
  });
}
