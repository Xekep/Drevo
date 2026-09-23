import test from "node:test";
import assert from "node:assert/strict";
import { familySpotlight } from "../src/components/tree/family-spotlight.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

test("подсветка семейной группы выбирает её карточки, а не копии из других союзов", () => {
  const groupId = '["parent-a","parent-b"]';
  const union = `union:${groupId}`;
  const geometry: TreeGeometry = {
    mode: "generations",
    reverse: false,
    start: 1700,
    offset: 0,
    positions: [
      ["parent-a", { x: 100, y: 0 }],
      ["parent-a-in-this-family", { x: 300, y: 0 }],
      ["parent-b", { x: 500, y: 0 }],
      ["child", { x: 400, y: 200 }],
      ["child-in-this-family", { x: 400, y: 100 }],
    ],
    occurrences: [
      {
        id: "parent-a",
        personId: "parent-a",
        block: 'union:["parent-a","other"]',
      },
      { id: "parent-a-in-this-family", personId: "parent-a", block: union },
      { id: "parent-b", personId: "parent-b", block: union },
      { id: "child", personId: "child", block: 'union:["child"]' },
      { id: "child-in-this-family", personId: "child", block: "continuation" },
    ],
    branches: [
      {
        id: "child:child",
        source: "parent-a-in-this-family",
        target: "child-in-this-family",
        union,
        relations: [
          { from: "parent-a", to: "child", type: "parent" },
          { from: "parent-b", to: "child", type: "parent" },
        ],
        route: { sourceHandle: "bottom", targetHandle: "top", points: [] },
      },
    ],
  };

  assert.deepEqual(
    familySpotlight(geometry, groupId, ["parent-a", "parent-b", "child"]),
    ["parent-a-in-this-family", "parent-b", "child-in-this-family"],
  );
});
