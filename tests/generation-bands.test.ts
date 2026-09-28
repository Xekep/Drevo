import test from "node:test";
import assert from "node:assert/strict";
import type { ElkNode } from "elkjs";
import { alignGenerationBands } from "../src/domain/generation-bands.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import { segmentHitsBox } from "../src/domain/edge-routing.ts";

function drawing(lanes: number, height = 84): ElkNode {
  const slot = height + 60;
  return {
    id: "tree",
    children: [
      {
        id: "parent",
        x: 0,
        y: 0,
        width: 220,
        height: slot,
        layoutOptions: { "elk.partitioning.partition": "0" },
      },
      ...Array.from({ length: lanes }, (_, i) => ({
        id: `child-${i}`,
        x: (i + 1) * 284,
        y: 2000,
        width: 220,
        height: slot,
        layoutOptions: { "elk.partitioning.partition": "1" },
      })),
    ],
    edges: Array.from({ length: lanes }, (_, i) => ({
      id: `edge-${i}`,
      sources: ["parent"],
      targets: [`child-${i}`],
      sections: [
        {
          id: `s-${i}`,
          startPoint: { x: 110, y: slot },
          endPoint: { x: (i + 1) * 284 + 110, y: 2000 },
          bendPoints: [
            { x: 110, y: 400 + i * 50 },
            { x: (i + 1) * 284 + 110, y: 400 + i * 50 },
          ],
        },
      ],
    })),
  };
}

test("large empty vertical gaps compact while every routing lane keeps its order", () => {
  const original = drawing(4),
    before = structuredClone(original);
  const { graph, bands, offsets } = alignGenerationBands(
    original,
    { width: 220, height: 84 },
  );
  assert.deepEqual(original, before);
  assert.equal(bands[1].targetY - bands[0].targetY, 204);
  assert.ok(offsets.get("parent")! > 0);
  assert.ok(offsets.get("child-0")! < 0);
  const ys = graph.edges!.map((e) => e.sections![0].bendPoints![0].y);
  for (let i = 1; i < ys.length; i++) assert.equal(ys[i] - ys[i - 1], 12);
  for (const edge of graph.edges!) {
    const section = edge.sections![0];
    const points = [
      section.startPoint,
      ...section.bendPoints!,
      section.endPoint,
    ];
    for (let i = 1; i < points.length; i++) {
      assert.ok(
        points[i].x === points[i - 1].x || points[i].y === points[i - 1].y,
      );
      for (const node of graph.children!)
        assert.equal(
          segmentHitsBox(points[i - 1], points[i], {
            left: node.x!,
            right: node.x! + node.width!,
            top: node.y!,
            bottom: node.y! + node.height!,
          }),
          false,
        );
    }
  }
});

test("simple generations use 180px pitch and portrait cards reserve their actual height", () => {
  for (const variant of ["classic", "portrait"] as const) {
    const size = (variant === "portrait" ? treeNodeSize() : { width: 220, height: 84 }),
      graph = drawing(1, size.height);
    const { bands } = alignGenerationBands(graph, size);
    assert.equal(bands[1].targetY - bands[0].targetY, size.height + 96);
  }
});

test("a dense routing corridor keeps necessary space instead of collapsing lines", () => {
  const { graph, bands } = alignGenerationBands(drawing(30), { width: 220, height: 84 });
  assert.equal(bands[1].targetY - bands[0].targetY, 144 + 31 * 12);
  const ys = graph.edges!.map((e) => e.sections![0].bendPoints![0].y);
  for (let i = 1; i < ys.length; i++) assert.equal(ys[i] - ys[i - 1], 12);
});

test("empty input has no bands", () => {
  assert.deepEqual(alignGenerationBands({ id: "empty" }, treeNodeSize()), {
    graph: { id: "empty" },
    bands: [],
    offsets: new Map(),
  });
});
