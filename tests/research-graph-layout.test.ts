import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import { parseResearchMermaid } from "../src/domain/research-visual.ts";
import { researchGraphLayoutInput } from "../src/domain/research-graph-layout.ts";

test("directed research layouts preserve all Mermaid orientations and parent order", async () => {
  for (const direction of ["LR", "RL", "TD", "TB", "BT"]) {
    const parsed = parseResearchMermaid(
      `graph ${direction}\na[Родитель] -->|отец| b[Ребёнок]\nb --> c[Внук]`,
    );
    assert.equal(parsed.kind, "graph");
    if (parsed.kind !== "graph") continue;
    assert.equal(parsed.graph.direction, direction);
    const layout = await new ELK().layout(
      researchGraphLayoutInput(parsed.graph),
    );
    const positions = new Map(layout.children!.map((node) => [node.id, node]));
    const axis = ["LR", "RL"].includes(direction) ? "x" : "y";
    const sign = ["RL", "BT"].includes(direction) ? -1 : 1;
    assert.ok(
      sign * positions.get("a")![axis]! < sign * positions.get("b")![axis]!,
    );
    assert.ok(
      sign * positions.get("b")![axis]! < sign * positions.get("c")![axis]!,
    );
  }
});

test("research graphs tolerate cycles and ignore references to absent nodes", async () => {
  const input = researchGraphLayoutInput({
    nodes: [
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ],
    edges: [
      { from: "a", to: "b", type: "parent" },
      { from: "b", to: "a", type: "parent" },
      { from: "a", to: "missing", type: "parent" },
    ],
  });
  assert.equal(input.edges!.length, 2);
  const layout = await new ELK().layout(input);
  assert.equal(layout.children!.length, 2);
  assert.ok(
    layout.children!.every(
      (node) => Number.isFinite(node.x) && Number.isFinite(node.y),
    ),
  );
});
