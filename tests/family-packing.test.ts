import test from "node:test";
import assert from "node:assert/strict";
import { compactFamilyLayout } from "../src/domain/family-packing.ts";
import type { ElkNode } from "elkjs";

test("optional compact layout failure keeps the complete baseline and does not mutate its input", async () => {
  const graph: ElkNode = {
    id: "root",
    children: [
      { id: "a", width: 220, height: 96 },
      { id: "b", width: 220, height: 96 },
    ],
    edges: [],
  };
  const before = structuredClone(graph);
  const result = await compactFamilyLayout(graph, async (request) => {
    if (
      request.layoutOptions?.["elk.layered.layering.strategy"] === "MIN_WIDTH"
    )
      throw new Error("optional optimization failed");
    request.children![0].x = 0;
    request.children![0].y = 0;
    request.children![1].x = 10000;
    request.children![1].y = 220;
    return request;
  });
  assert.deepEqual(graph, before);
  assert.deepEqual(
    result.children!.map((n) => n.id),
    ["a", "b"],
  );
  assert.equal(result.children![1].x, 10000);
});
