import test from "node:test";
import assert from "node:assert/strict";
import type { ElkNode } from "elkjs";
import {
  fromSketchUnionGraph,
  siftUnionOrder,
} from "../src/domain/union-order.ts";

const node = (id: string): ElkNode => ({
  id,
  width: 220,
  height: 96,
  ports: [{ id: `${id}:port` }],
});

test("sifting reorders union blocks to remove an adjacent-layer crossing", () => {
  const graph: ElkNode = {
    id: "family",
    children: [node("a"), node("b"), node("c"), node("d")],
    edges: [
      { id: "ad", sources: ["a:port"], targets: ["d:port"] },
      { id: "bc", sources: ["b:port"], targets: ["c:port"] },
    ],
  };
  const result = siftUnionOrder(graph);
  const order = new Map(result.children!.map((entry, index) => [entry.id, index]));
  assert.ok((order.get("a")! - order.get("b")!) *
    (order.get("d")! - order.get("c")!) > 0);
  assert.equal(result.layoutOptions?.["elk.layered.crossingMinimization.forceNodeModelOrder"], "true");
  assert.deepEqual(graph.children!.map((entry) => entry.id), ["a", "b", "c", "d"]);
});

test("cyclic layout input keeps its original order", () => {
  const graph: ElkNode = {
    id: "cycle",
    children: [node("a"), node("b"), node("c")],
    edges: [
      { id: "ab", sources: ["a:port"], targets: ["b:port"] },
      { id: "ba", sources: ["b:port"], targets: ["a:port"] },
    ],
  };
  assert.equal(siftUnionOrder(graph), graph);
});

test("interactive ordering passes previous union positions to ELK without changing input", () => {
  const graph: ElkNode = {
    id: "family",
    children: [node("a"), node("b"), node("c")],
    edges: [{ id: "ac", sources: ["a:port"], targets: ["c:port"] }],
  };
  const previous = {
    positions: [
      ["person-a", { x: 100, y: 0 }],
      ["person-b", { x: 400, y: 0 }],
      ["person-c", { x: 100, y: 300 }],
    ] as [string, { x: number; y: number }][],
    occurrences: [
      { id: "person-a", personId: "a", block: "a" },
      { id: "person-b", personId: "b", block: "b" },
      { id: "person-c", personId: "c", block: "c" },
    ],
  };
  const result = fromSketchUnionGraph(graph, previous)!;
  assert.equal(result.layoutOptions?.["elk.layered.crossingMinimization.semiInteractive"], "true");
  assert.equal(result.children?.[0].layoutOptions?.["elk.position"], "(100, 0)");
  assert.equal(result.children?.[2].layoutOptions?.["elk.position"], "(100, 300)");
  assert.equal(graph.children?.[0].layoutOptions, undefined);
  assert.equal(fromSketchUnionGraph(graph, { ...previous, occurrences: [] }), undefined);
  const reversed = fromSketchUnionGraph(graph, {
    ...previous,
    positions: previous.positions.map(([id, point]) => [
      id, { x: point.x, y: 300 - point.y },
    ] as [string, { x: number; y: number }]),
  }, true)!;
  assert.equal(reversed.children?.[2].layoutOptions?.["elk.position"], "(100, 300)");
});
