import test from "node:test";
import assert from "node:assert/strict";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import {
  translateFamilyBlocks,
  routeFamilyMove,
} from "../src/domain/family-row-moves.ts";

for (const reverse of [false, true]) {
  test(`a rigid family translation keeps internal detours (reverse=${reverse})`, () => {
    const y = (value: number) => reverse ? 264 - value : value;
    const original: TreeGeometry = {
      mode: "generations", reverse, start: 1700, offset: 0,
      positions: [
        ["parent", { x: 0, y: 0 }],
        ["child", { x: 600, y: reverse ? -1000 : 1000 }],
        ["other", { x: 1200, y: reverse ? -500 : 500 }],
      ],
      occurrences: ["parent", "child", "other"].map((id) => ({
        id, personId: id, block: id,
      })),
      branches: [{
        id: "child:internal", source: "parent", target: "child", union: "family",
        relations: [{ from: "parent", to: "child", type: "parent" }],
        route: {
          sourceHandle: reverse ? "top" : "bottom",
          targetHandle: reverse ? "bottom" : "top",
          points: [
            [110, 264], [110, 340], [400, 340],
            [400, 800], [710, 800], [710, 1000],
          ].map(([x, value]) => ({ x, y: y(value) })),
        },
      }],
    };
    const saved = structuredClone(original);
    const moved = translateFamilyBlocks(original, new Map([
      ["parent", -300], ["child", -300],
    ]));
    const expected = original.branches![0].route.points.map((p) => ({
      ...p, x: p.x - 300,
    }));
    assert.deepEqual(moved.geometry.branches![0].route.points, expected);
    const final = routeFamilyMove(moved, { width: 220, height: 264 },
      new Set(["child:internal"]));
    assert.deepEqual(final.branches![0].route.points, expected);
    assert.deepEqual(final.positions.find(([id]) => id === "other"),
      original.positions.find(([id]) => id === "other"));
    assert.deepEqual(original, saved);
  });
}
