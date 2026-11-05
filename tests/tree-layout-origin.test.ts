import test from "node:test";
import assert from "node:assert/strict";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { translateTreeGeometry, treeLayoutOrigin } from "../src/components/tree/tree-layout-origin.ts";

const geometry: TreeGeometry = {
  mode: "generations", reverse: false, start: 1900, offset: 0,
  positions: [["anchor", { x: 100, y: 200 }], ["child", { x: 400, y: 600 }]],
  routes: [["edge", { sourceHandle: "bottom", targetHandle: "top", points: [{ x: 210, y: 464 }, { x: 510, y: 600 }] }]],
  blocks: [{ id: "pair", members: ["anchor"], x: 90, y: 190, width: 240, height: 280 }],
  siblingGroups: [{ id: "siblings", members: ["child"], x: 390, y: 590, width: 240, height: 280 }],
  generationBands: [{ level: 0, targetY: 200, minY: 190, maxY: 210, members: ["anchor"] }],
};
geometry.branches = [{ id: "branch", source: "anchor", target: "child", union: "pair",
  relations: [{ from: "anchor", to: "child", type: "parent" }], route: geometry.routes![0][1] }];

test("cached projection origin keeps the anchor while preserving a real rearrangement", () => {
  const previous = structuredClone(geometry);
  const next = translateTreeGeometry(geometry, { x: 5000, y: -3000 });
  next.positions[1][1].x += 120;
  const raw = structuredClone(next);
  const aligned = translateTreeGeometry(next, treeLayoutOrigin(previous, next, "anchor"));
  assert.deepEqual(aligned.positions[0], previous.positions[0]);
  assert.deepEqual(aligned.positions[1], ["child", { x: 520, y: 600 }]);
  for (const field of ["routes", "branches", "blocks", "siblingGroups", "generationBands"] as const)
    assert.deepEqual(aligned[field], previous[field], `${field} must share the cards' origin`);
  assert.deepEqual(next, raw, "the cached geometry cannot be mutated");
});

test("anchor correspondence uses person identity across changed occurrence IDs", () => {
  const previous: TreeGeometry = { ...geometry, positions: [["old-copy", { x: 100, y: 200 }]],
    occurrences: [{ id: "old-copy", personId: "anchor", block: "old" }] };
  const next: TreeGeometry = { ...geometry, positions: [["new-copy", { x: 900, y: -400 }]],
    occurrences: [{ id: "new-copy", personId: "anchor", block: "new" }] };
  assert.deepEqual(treeLayoutOrigin(previous, next, "anchor"), { x: -800, y: 600 });
});

test("a missing anchor uses the retained scene, while disjoint projections keep their origin", () => {
  const moved = translateTreeGeometry(geometry, { x: -5000, y: 3000 });
  assert.deepEqual(treeLayoutOrigin(geometry, moved, "removed"), { x: 5000, y: -3000 });
  assert.deepEqual(treeLayoutOrigin(geometry, { ...geometry, positions: [["unrelated", { x: 8, y: 9 }]] }), { x: 0, y: 0 });
  assert.equal(translateTreeGeometry(geometry, { x: 0, y: 0 }), geometry);
});
