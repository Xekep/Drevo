import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import { repairAdditionalRoutes } from "../src/domain/additional-route-repair.ts";
import { routeKey, routeRelationships } from "../src/domain/edge-routing.ts";
import { routingQuality } from "../src/domain/routing-quality.ts";
import { createGeometryContactScorer, unionGeometry } from "../src/domain/union-layout.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import type { FamilyLink } from "../src/domain/types.ts";
import { randomFamily } from "./layout-fixtures.ts";

const size = treeNodeSize();
const score = (g: TreeGeometry) => routingQuality([
  ...(g.branches || []).map(b => ({ group: b.union, route: b.route })),
  ...(g.routes || []).map(([id, route]) => ({ group: `extra:${id}`, route })),
]);

test("changing an extra tie's ports removes a crossing without moving its family", () => {
  const link = { type: "guardian", from: "a", to: "b" } as const;
  const geometry: TreeGeometry = {
    mode: "generations", reverse: false, start: 1700, offset: 0, nodeSize: size,
    positions: [["a", { x: 0, y: 100 }], ["b", { x: 1000, y: 100 }],
      ["parent", { x: 2890, y: -264 }], ["child", { x: 2890, y: 300 }]],
    routes: [[routeKey(link), { sourceHandle: "right", targetHandle: "top", points: [
      { x: 220, y: 232 }, { x: 800, y: 232 }, { x: 800, y: 90 },
      { x: 1110, y: 90 }, { x: 1110, y: 100 },
    ] }]],
    branches: [{ id: "family", source: "parent", target: "child", union: "family",
      relations: [{ type: "parent", from: "parent", to: "child" }],
      route: { sourceHandle: "bottom", targetHandle: "top", points: [
        { x: 3000, y: 0 }, { x: 600, y: 0 }, { x: 600, y: 300 },
        { x: 800, y: 300 }, { x: 800, y: 90 }, { x: 3000, y: 90 }, { x: 3000, y: 300 },
      ] } }],
  };
  const snapshot = structuredClone(geometry), before = score(geometry);
  const result = repairAdditionalRoutes(geometry, [link], size);
  const after = score(result);
  assert.equal(before.crossings, 1);
  assert.equal(after.crossings, 0);
  assert.ok(after.contacts <= before.contacts);
  assert.ok(after.length <= before.length);
  assert.strictEqual(result.positions, geometry.positions);
  assert.strictEqual(result.branches, geometry.branches);
  assert.deepEqual(geometry, snapshot);
  const cards = createGeometryContactScorer(size.width, size.height);
  assert.equal(cards.cardContacts(result), 0);
  assert.strictEqual(repairAdditionalRoutes(geometry, [link], size, 0), geometry);
  const oversized = { ...geometry, positions: Array.from({ length: 1601 }, (_, i) =>
    [`unrelated-${i}`, { x: i * 300, y: 0 }] as [string, { x: number; y: number }]) };
  assert.strictEqual(repairAdditionalRoutes(oversized, [link], size), oversized);
});

for (const reverse of [false, true]) test(`extra routing keeps every person, relation and family coordinate (${reverse})`, async () => {
  const people = randomFamily(3, 3), elk = new ELK({ algorithms: ["layered"] });
  const family = await unionGeometry(people, graph => elk.layout(graph), reverse, [], size);
  const links: Pick<FamilyLink, "type" | "from" | "to">[] = [
    { type: "guardian", from: people[0].id, to: people.at(-1)!.id },
    { type: "godparent", from: people[1].id, to: people.at(-2)!.id },
    { type: "sworn_sibling", from: people[2].id, to: people.at(-3)!.id },
  ];
  const nodes = family.positions.map(([id]) => ({ id, birth: "", parents: [], spouses: [] }));
  const routes = routeRelationships(nodes, links, family.positions, size.width, size.height,
    new Set(), family.branches!.map(b => ({ group: b.union, route: b.route })));
  assert.equal(routes.length, links.length);
  const original = { ...family, routes }, snapshot = structuredClone(original);
  const result = repairAdditionalRoutes(original, links, size), before = score(original), after = score(result);
  assert.strictEqual(result.positions, original.positions);
  assert.strictEqual(result.branches, original.branches);
  assert.strictEqual(result.generationBands, original.generationBands);
  assert.deepEqual(result.routes!.map(([id]) => id), routes.map(([id]) => id));
  assert.ok(after.crossings <= before.crossings);
  assert.ok(after.contacts <= before.contacts);
  assert.ok(after.length <= before.length * 1.02 + 0.01);
  assert.ok(after.bends <= before.bends + 4);
  const oldPoints = [...original.positions.flatMap(([, p]) => [p, { x: p.x + size.width, y: p.y + size.height }]),
    ...original.branches!.flatMap(b => b.route.points), ...routes.flatMap(([, r]) => r.points)];
  const xs = oldPoints.map(p => p.x), ys = oldPoints.map(p => p.y);
  for (const [, route] of result.routes!) for (const point of route.points) {
    assert.ok(point.x >= Math.min(...xs) && point.x <= Math.max(...xs));
    assert.ok(point.y >= Math.min(...ys) && point.y <= Math.max(...ys));
  }
  const cards = createGeometryContactScorer(size.width, size.height);
  assert.ok(cards.cardContacts(result) <= cards.cardContacts(original));
  assert.deepEqual(original, snapshot);
});
