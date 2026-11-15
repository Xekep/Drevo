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

test("wide generations retain transitive local orders instead of skipping the joint search", () => {
  const { graph, sketch } = fixture();
  for (let i = 0; i < 60; i++) {
    const id = `unrelated-${i}`;
    graph.children!.push({ id, width: 100, y: 0 });
    sketch.positions.push([id, { x: 1000 + i * 200, y: 0 }]);
    sketch.occurrences!.push({ id, personId: id, block: id });
  }
  const saved = structuredClone({ graph, sketch });
  const plan = jointUnionOrder(graph, sketch)!;
  assert.ok(plan);
  assert.equal(plan.crossings, 0);
  assert.equal(plan.originalCrossings, 1);
  assert.equal(plan.order.size, graph.children!.length);
  assert.equal(new Set(plan.order.values()).size, plan.order.size);
  for (let i = 5; i < 60; i++)
    assert.ok(plan.order.get("a")! < plan.order.get(`unrelated-${i}`)!);
  assert.deepEqual(jointUnionOrder(graph, sketch), plan);
  assert.deepEqual({ graph, sketch }, saved);
});

test("a joint proposal may reduce interleaving with bounded total spread, preserving the worst family", () => {
  const positions: TreeGeometry["positions"] = [
    ["parent", { x: 300, y: 0 }], ["other-parent", { x: -900, y: 0 }],
    ["a", { x: 0, y: 500 }], ["unrelated", { x: 200, y: 500 }],
    ["b", { x: 400, y: 500 }], ["other-child", { x: 100, y: 1000 }],
  ];
  const before: TreeGeometry = {
    mode: "generations", reverse: false, start: 1700, offset: 0, positions,
    occurrences: positions.map(([id]) => ({ id, personId: id, block: id })),
    generationBands: [0, 500, 1000].map((y, level) => ({ level, targetY: y, minY: y, maxY: y,
      members: positions.filter(([, p]) => p.y === y).map(([id]) => id) })),
    branches: ["a", "b", "other-child"].map(target => {
      const source = target === "other-child" ? "other-parent" : "parent";
      const from = new Map(positions).get(source)!, to = new Map(positions).get(target)!;
      return { id: `child:${target}`, source, target, union: source, relations: [],
        route: { sourceHandle: "bottom", targetHandle: "top", points: [
          { x: from.x + 50, y: from.y + 84 }, { x: from.x + 50, y: to.y - 100 },
          { x: to.x + 50, y: to.y - 100 }, { x: to.x + 50, y: to.y },
        ] } };
    }),
  };
  const after = structuredClone(before);
  after.positions.find(([id]) => id === "b")![1].x = 200;
  after.positions.find(([id]) => id === "unrelated")![1].x = 400;
  after.branches![1].route.points.slice(2).forEach(p => { p.x = 250; });
  const score = (g: TreeGeometry) => ({ crossings: g === before ? 10 : 9,
    contacts: 10, length: g === before ? 1000 : 1040, bends: 4, cardHits: 0, overlaps: 0 });
  const size = { width: 100, height: 84 };
  assert.equal(preferJointUnionLayout(after, before, size, score), true);
  assert.equal(preferJointUnionLayout(after, before, size, g => ({ ...score(g),
    length: g === before ? 1000 : 1060 })), false, "line length increase is bounded");
  const worse = structuredClone(after);
  worse.positions.find(([id]) => id === "other-child")![1].x += 100;
  assert.equal(preferJointUnionLayout(worse, before, size, score), false,
    "the worst family must not become more spread out");
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
