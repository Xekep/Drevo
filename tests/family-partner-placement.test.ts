import test from "node:test";
import assert from "node:assert/strict";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import type { UnionBranch } from "../src/domain/union-layout.ts";
import { createGeometryContactScorer } from "../src/domain/union-layout.ts";
import { freePartnerPlacements } from "../src/domain/family-partner-placement.ts";
import { refineFinalCoupleOrder } from "../src/domain/family-layout-candidates.ts";

const size = { width: 220, height: 264 };
const child = (id: string, source: string, target: string, union: string, points: { x: number; y: number }[]): UnionBranch => ({
  id: `child:${id}`, source, target, union, relations: [{ from: source, to: target, type: "parent" }],
  route: { sourceHandle: "bottom", targetHandle: "top", points },
});
function fixture(): TreeGeometry {
  return {
    mode: "generations", reverse: false, nodeSize: size, start: 1800, offset: 0,
    positions: [["ancestor", { x: 0, y: -400 }], ["anchored", { x: 0, y: 0 }], ["free", { x: 252, y: 0 }],
      ["child", { x: -126, y: 400 }], ["child-partner", { x: 126, y: 400 }], ["foreign", { x: 700, y: 0 }]],
    occurrences: ["ancestor", "anchored", "free", "child", "child-partner", "foreign"].map(id => ({
      id, personId: id, block: ["anchored", "free"].includes(id) ? "parents" : ["child", "child-partner"].includes(id) ? "children" : id,
    })),
    blocks: [{ id: "parents", members: ["anchored", "free"], x: 0, y: 0, width: 472, height: 264 },
      { id: "children", members: ["child", "child-partner"], x: -126, y: 400, width: 472, height: 264 }],
    branches: [
      child("anchored", "ancestor", "anchored", "ancestry", [{ x: 110, y: -136 }, { x: 110, y: 0 }]),
      { id: "pair:parents", source: "anchored", target: "free", union: "parents",
        relations: [{ from: "anchored", to: "free", type: "spouse" }],
        route: { sourceHandle: "right", targetHandle: "left", points: [{ x: 220, y: 132 }, { x: 252, y: 132 }] } },
      child("child", "anchored", "child", "parents", [{ x: 236, y: 132 }, { x: 236, y: 330 }, { x: -16, y: 330 }, { x: -16, y: 400 }]),
      child("child-partner", "foreign", "child-partner", "foreign", [{ x: 810, y: 264 }, { x: 810, y: 296 }, { x: 236, y: 296 }, { x: 236, y: 400 }]),
      { id: "pair:children", source: "child", target: "child-partner", union: "children", relations: [],
        route: { sourceHandle: "right", targetHandle: "left", points: [{ x: 94, y: 532 }, { x: 126, y: 532 }] } },
    ],
    generationBands: [-1, 0, 1].map((level, i) => ({ level, targetY: (i - 1) * 400,
      minY: (i - 1) * 400, maxY: (i - 1) * 400,
      members: i === 0 ? ["ancestor"] : i === 1 ? ["anchored", "free", "foreign"] : ["child", "child-partner"],
    })),
  };
}
function scoreFor() {
  const scorer = createGeometryContactScorer(size.width, size.height);
  return (g: TreeGeometry) => ({ ...scorer.quality(g), cardHits: scorer.cardContacts(g), overlaps: scorer.cardOverlaps(g) });
}
for (const mirror of [false, true]) for (const reverse of [false, true]) test(`free partner changes side to straighten a child line without moving ancestry (mirror=${mirror}, reverse=${reverse})`, () => {
  const input = fixture();
  if (mirror) {
    input.positions.forEach(([, p]) => { p.x = 1200 - p.x - size.width; });
    input.blocks!.forEach(b => { b.x = 1200 - b.x - b.width; });
    input.branches!.forEach(b => {
      b.route.points.forEach(p => { p.x = 1200 - p.x; });
      b.route.sourceHandle = b.route.sourceHandle === "left" ? "right" : b.route.sourceHandle === "right" ? "left" : b.route.sourceHandle;
      b.route.targetHandle = b.route.targetHandle === "left" ? "right" : b.route.targetHandle === "right" ? "left" : b.route.targetHandle;
    });
  }
  if (reverse) {
    input.reverse = true;
    input.positions.forEach(([, p]) => { p.y = 1200 - p.y - size.height; });
    input.blocks!.forEach(b => { b.y = 1200 - b.y - b.height; });
    input.branches!.forEach(b => {
      b.route.points.forEach(p => { p.y = 1200 - p.y; });
      b.route.sourceHandle = b.route.sourceHandle === "top" ? "bottom" : b.route.sourceHandle === "bottom" ? "top" : b.route.sourceHandle;
      b.route.targetHandle = b.route.targetHandle === "top" ? "bottom" : b.route.targetHandle === "bottom" ? "top" : b.route.targetHandle;
    });
  }
  const snapshot = structuredClone(input), score = scoreFor(), result = refineFinalCoupleOrder(input, [], [], size, score);
  const positions = new Map(result.positions), old = new Map(input.positions);
  assert.equal(positions.get("free")!.x, 2 * old.get("anchored")!.x - old.get("free")!.x);
  for (const [id, p] of input.positions) if (id !== "free") assert.deepEqual(positions.get(id), p);
  const route = result.branches!.find(b => b.id === "child:child")!.route.points;
  assert.equal(route[0].x, route.at(-1)!.x);
  assert.equal(score(result).contacts, 0);
  assert.ok(score(result).length < score(input).length);
  assert.equal(score(result).cardHits, 0);
  assert.equal(score(result).overlaps, 0);
  assert.deepEqual(result.branches!.map(b => b.relations), input.branches!.map(b => b.relations));
  assert.deepEqual(input, snapshot);
});

test("partner relocation rejects blocked slots and does not move endpoints of additional relations", () => {
  const input = fixture(), score = scoreFor();
  input.positions.push(["blocker", { x: -252, y: 0 }]);
  const result = refineFinalCoupleOrder(input, [], [], size, score);
  assert.equal(new Map(result.positions).get("free")!.x, 252);
  assert.equal(score(result).overlaps, 0);
  assert.equal(freePartnerPlacements(fixture(), [{ type: "godparent", from: "free", to: "foreign" }], size).length, 0);
  const known = fixture();
  known.branches!.push(child("free", "ancestor", "free", "ancestry", [{ x: 110, y: -136 }, { x: 110, y: -40 }, { x: 362, y: -40 }, { x: 362, y: 0 }]));
  assert.equal(freePartnerPlacements(known, [], size).length, 0);
});
