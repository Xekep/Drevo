import test from "node:test";
import assert from "node:assert/strict";
import type { ElkNode } from "elkjs";
import { jointUnionOrder } from "../src/domain/joint-union-order.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { preferJointUnionLayout } from "../src/domain/family-layout-candidates.ts";

function fixture() {
  const graph: ElkNode = {
    id: "graph",
    children: [
      { id: "a", width: 100, y: 0, ports: [{ id: "a-out", x: 50 }] },
      { id: "b", width: 100, y: 0, ports: [{ id: "b-out", x: 50 }] },
      {
        id: "pair",
        width: 232,
        y: 200,
        ports: [
          {
            id: "pair-left",
            x: 50,
            layoutOptions: { "elk.port.side": "NORTH" },
          },
          {
            id: "pair-right",
            x: 182,
            layoutOptions: { "elk.port.side": "NORTH" },
          },
        ],
      },
    ],
    edges: [
      { id: "1", sources: ["a-out"], targets: ["pair-right"] },
      { id: "2", sources: ["b-out"], targets: ["pair-left"] },
    ],
  };
  const sketch: Pick<TreeGeometry, "positions" | "occurrences"> = {
    positions: [
      ["a", { x: 0, y: 0 }],
      ["b", { x: 200, y: 0 }],
      ["left", { x: 0, y: 200 }],
      ["right", { x: 132, y: 200 }],
    ],
    occurrences: ["a", "b", "left", "right"].map((id) => ({
      id,
      personId: id,
      block: id === "a" || id === "b" ? id : "pair",
    })),
  };
  return { graph, sketch };
}

test("joint order removes a crossing by choosing household order and pair sides together", () => {
  const { graph, sketch } = fixture(),
    snapshot = structuredClone({ graph, sketch });
  const plan = jointUnionOrder(graph, sketch)!;
  assert.equal(plan.originalCrossings, 1);
  assert.equal(plan.crossings, 0);
  assert.deepEqual(
    new Set(plan.order.keys()),
    new Set(graph.children!.map((n) => n.id)),
  );
  const parentForward = plan.order.get("a")! < plan.order.get("b")!;
  assert.equal(plan.flippedPairs.has("pair"), parentForward);
  assert.deepEqual(jointUnionOrder(graph, sketch), plan);
  assert.deepEqual({ graph, sketch }, snapshot);
});

test("unsupported or over-budget models retain the complete original input", () => {
  const { graph, sketch } = fixture();
  graph.children![0].y = undefined;
  assert.equal(jointUnionOrder(graph, sketch), undefined);
  const wide: ElkNode = {
    id: "wide",
    children: Array.from({ length: 100 }, (_, i) => ({
      id: String(i),
      y: 0,
      width: 100,
    })),
  };
  const snapshot = structuredClone(wide);
  assert.equal(jointUnionOrder(wide, sketch), undefined);
  assert.deepEqual(wide, snapshot);
});

test("joint acceptance checks additional routes and never accepts a tiny primary improvement", () => {
  const before: TreeGeometry = {
    mode: "generations",
    reverse: false,
    start: 1700,
    offset: 0,
    positions: [],
    occurrences: [],
    branches: [
      {
        id: "main",
        source: "a",
        target: "b",
        union: "family",
        relations: [],
        route: {
          sourceHandle: "right",
          targetHandle: "left",
          points: [
            { x: 0, y: 0 },
            { x: 100, y: 0 },
          ],
        },
      },
    ],
    routes: [
      [
        "additional",
        {
          sourceHandle: "bottom",
          targetHandle: "top",
          points: [
            { x: 150, y: -50 },
            { x: 150, y: 50 },
          ],
        },
      ],
    ],
  };
  const after = structuredClone(before),
    size = { width: 100, height: 120 };
  const score = (g: TreeGeometry) => ({
    crossings: g === before ? 10 : 4,
    contacts: 10,
    length: 100,
    bends: 4,
    cardHits: 0,
    overlaps: 0,
  });
  assert.equal(preferJointUnionLayout(after, before, size, score), true);
  after.routes![0][1].points.forEach((p) => {
    p.x = 50;
  });
  assert.equal(
    preferJointUnionLayout(after, before, size, score),
    false,
    "additional line now crosses the family",
  );
  after.routes = structuredClone(before.routes);
  assert.equal(
    preferJointUnionLayout(after, before, size, (g) => ({
      ...score(g),
      crossings: g === before ? 100 : 99,
    })),
    false,
  );
  for (const field of [
    "cardHits",
    "overlaps",
    "contacts",
    "length",
    "bends",
  ] as const)
    assert.equal(
      preferJointUnionLayout(after, before, size, (g) => ({
        ...score(g),
        [field]: g === before ? 0 : 20,
      })),
      false,
      field,
    );
});
