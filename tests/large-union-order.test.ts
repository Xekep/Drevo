import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import { unionGeometry } from "../src/domain/union-layout.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import { routingQuality } from "../src/domain/routing-quality.ts";
import { bounds, segmentHitsBox, Spatial, type Box } from "../src/domain/edge-routing.ts";
import { randomFamily } from "./layout-fixtures.ts";

test("large decross keeps every genealogical fact and safe routes while improving the legacy fixture", { timeout: 120000 }, async () => {
  const people = randomFamily(5, 9), before = structuredClone(people), size = treeNodeSize();
  assert.equal(people.length, 977);
  const engine = new ELK({ algorithms: ["layered"] });
  const current = await unionGeometry(people, (graph) => engine.layout(graph), false, [], size);
  const legacy = await unionGeometry(people, (graph) => engine.layout(graph), false, [], size, undefined, false);
  const quality = (geometry: typeof current) => routingQuality(geometry.branches!.map((b) =>
    ({ group: b.union, route: b.route })));
  const oldQuality = quality(legacy), newQuality = quality(current);
  assert.ok(newQuality.contacts <= oldQuality.contacts);
  assert.ok(newQuality.crossings <= oldQuality.crossings);
  assert.ok(newQuality.length <= oldQuality.length * 1.1);
  const relations = new Set(current.branches!.flatMap((b) => b.relations.map(({ type, from, to }) =>
    JSON.stringify(type === "spouse" ? [type, ...[from, to].sort()] : [type, from, to]))));
  const expected = new Set(people.flatMap((p) => [
    ...p.parents.map((from) => JSON.stringify(["parent", from, p.id])),
    ...p.spouses.map((to) => JSON.stringify(["spouse", ...[p.id, to].sort()])),
  ]));
  assert.deepEqual(relations, expected);
  assert.equal(current.positions.length, current.occurrences!.length);
  assert.deepEqual(new Set(current.occurrences!.map((o) => o.personId)), new Set(people.map((p) => p.id)));
  const bands = new Map(current.generationBands!.flatMap((band) => band.members.map((id) => [id, band])));
  const cards = new Spatial<Box>();
  for (const [id, p] of current.positions) {
    assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
    assert.ok(p.y >= bands.get(id)!.minY && p.y <= bands.get(id)!.maxY);
    const card = { left: p.x, right: p.x + size.width, top: p.y, bottom: p.y + size.height };
    assert.equal(cards.query(card).filter((other) => card.left < other.right &&
      card.right > other.left && card.top < other.bottom && card.bottom > other.top).length, 0);
    cards.add(card);
  }
  for (const branch of current.branches!) {
    if (branch.id.startsWith("child:"))
      assert.ok(bands.get(branch.source)!.level < bands.get(branch.target)!.level);
    for (let i = 1; i < branch.route.points.length; i++) {
      const a = branch.route.points[i - 1], b = branch.route.points[i];
      assert.ok(Number.isFinite(b.x) && Number.isFinite(b.y));
      assert.ok(a.x === b.x || a.y === b.y);
      assert.equal(cards.query(bounds(a, b)).filter((card) => segmentHitsBox(a, b, card)).length, 0);
    }
  }
  const repeated = await unionGeometry(people, (graph) => engine.layout(graph), false, [], size);
  assert.deepEqual(repeated, current);
  assert.deepEqual(people, before);
});
