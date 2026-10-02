import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs";
import { presetGenerationLayers } from "../src/domain/union-layers.ts";
import { alignGenerationBands } from "../src/domain/generation-bands.ts";

function node(id: string, rank: number, height = 120): ElkNode {
  return {
    id,
    width: 160,
    height,
    layoutOptions: {
      "elk.partitioning.partition": String(rank),
      "elk.portConstraints": "FIXED_POS",
    },
    ports: [
      {
        id: `${id}:in`,
        x: 80,
        y: 0,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": "NORTH" },
      },
      {
        id: `${id}:out`,
        x: 80,
        y: height,
        width: 0,
        height: 0,
        layoutOptions: { "elk.port.side": "SOUTH" },
      },
    ],
  };
}

function graph(children: ElkNode[]): ElkNode {
  return {
    id: "family-layout",
    children,
    edges: [],
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.partitioning.activate": "true",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.randomSeed": "1",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.separateConnectedComponents": "true",
    },
  };
}

test("generation hints use actual coordinates and disjoint variable-height rank intervals", () => {
  const input = graph([
    node("a", 0, 120),
    node("b", 0, 80),
    node("c", 2, 90),
    node("d", 5, 60),
  ]);
  input.children![0].x = 270;
  input.children![0].y = -500;
  input.children![0].layoutOptions!["elk.position"] = "(270, -500)";
  const before = structuredClone(input),
    result = presetGenerationLayers(input);
  assert.notEqual(result, input);
  assert.deepEqual(input, before);
  assert.deepEqual(
    result.children!.map((entry) => [entry.x, entry.y]),
    [
      [270, 0],
      [0, 0],
      [0, 156],
      [0, 282],
    ],
  );
  assert.equal(result.layoutOptions!["elk.partitioning.activate"], "false");
  assert.equal(
    result.layoutOptions!["elk.layered.layering.strategy"],
    "INTERACTIVE",
  );
  for (let i = 0; i < input.children!.length; i++) {
    const original = input.children![i],
      hinted = result.children![i];
    assert.notEqual(hinted, original);
    assert.notEqual(hinted.layoutOptions, original.layoutOptions);
    assert.deepEqual(hinted.layoutOptions, original.layoutOptions);
    assert.equal(hinted.ports, original.ports);
    assert.equal(hinted.width, original.width);
    assert.equal(hinted.height, original.height);
  }
  assert.equal(result.edges, input.edges);
  assert.equal(result.layoutOptions!["elk.edgeRouting"], "ORTHOGONAL");
  assert.equal(
    result.layoutOptions!["elk.layered.considerModelOrder.strategy"],
    "NODES_AND_EDGES",
  );
});

test("invalid ranks, dimensions, identifiers and unsupported graph shape keep the original solver", () => {
  const original = graph([node("a", 0), node("b", 1)]);
  const cases: ((input: ElkNode) => void)[] = [
    (input) => {
      delete input.children![0].layoutOptions!["elk.partitioning.partition"];
    },
    ...["", " ", "NaN", "Infinity", "-1", "1.5"].map(
      (rank) => (input: ElkNode) => {
        input.children![0].layoutOptions!["elk.partitioning.partition"] = rank;
      },
    ),
    (input) => {
      input.children![0].height = Infinity;
    },
    (input) => {
      input.children![0].height = 0;
    },
    (input) => {
      delete input.children![0].height;
    },
    (input) => {
      input.children![0].x = NaN;
    },
    (input) => {
      input.children![0].height = Number.MAX_VALUE;
      input.children![1].height = Number.MAX_VALUE;
    },
    (input) => {
      input.children![1].id = "a";
    },
    (input) => {
      input.children![1].ports![0].id = "a:out";
    },
    (input) => {
      input.children![1].id = "a:in";
    },
    (input) => {
      input.children![0].children = [node("nested", 1)];
    },
    (input) => {
      input.ports = [{ id: "external" }];
    },
    (input) => {
      input.layoutOptions!["elk.direction"] = "UP";
    },
  ];
  for (const mutate of cases) {
    const input = structuredClone(original);
    mutate(input);
    const before = structuredClone(input);
    assert.equal(presetGenerationLayers(input), input);
    assert.deepEqual(input, before);
  }
  const empty = graph([]);
  assert.equal(presetGenerationLayers(empty), empty);
});

test("backward, same-rank and unresolved edges cannot silently change genealogy ranks", () => {
  const original = graph([node("a", 0), node("b", 1), node("c", 1)]);
  for (const [sources, targets] of [
    [["b:out"], ["a:in"]],
    [["b:out"], ["c:in"]],
    [["missing"], ["c:in"]],
    [["a:out"], ["missing"]],
    [[], ["b:in"]],
    [["a:out"], []],
    [["a:out", "b:out"], ["c:in"]],
  ]) {
    const input = { ...original, edges: [{ id: "invalid", sources, targets }] };
    assert.equal(presetGenerationLayers(input), input);
  }
  const forward = {
    ...original,
    edges: [{ id: "valid", sources: ["a"], targets: ["b:in", "c"] }],
  };
  assert.notEqual(presetGenerationLayers(forward), forward);
});

test("ELK keeps disconnected generation ranks and orthogonal fixed-port routes with a spanning edge", async () => {
  const input = graph([
    node("a", 0),
    node("b", 0),
    node("c", 1),
    node("d", 3),
    node("e", 1),
    node("f", 3),
    node("isolated", 5),
  ]);
  input.edges = [
    { id: "a-c", sources: ["a:out"], targets: ["c:in"] },
    { id: "c-d", sources: ["c:out"], targets: ["d:in"] },
    { id: "a-d", sources: ["a:out"], targets: ["d:in"] },
    { id: "e-f", sources: ["e:out"], targets: ["f:in"] },
  ];
  const before = structuredClone(input);
  const elk = new ELK();
  const laidOut = await elk.layout(
    structuredClone(presetGenerationLayers(input)),
  );
  const { graph: aligned, bands } = alignGenerationBands(laidOut, {
    width: 160,
    height: 120,
  });
  assert.deepEqual(input, before);
  assert.deepEqual(
    bands.map((band) => band.level),
    [0, 1, 3, 5],
  );
  const byId = new Map(aligned.children!.map((entry) => [entry.id, entry]));
  const byRank = new Map<number, number>();
  for (const entry of aligned.children!) {
    const rank = Number(entry.layoutOptions!["elk.partitioning.partition"]);
    if (byRank.has(rank)) assert.equal(entry.y, byRank.get(rank));
    byRank.set(rank, entry.y!);
    assert.equal(entry.layoutOptions!["elk.portConstraints"], "FIXED_POS");
    for (const port of entry.ports!) {
      assert.equal(port.x, 80);
      assert.ok(port.y === (port.id.endsWith(":in") ? 0 : 120));
    }
  }
  const ranked = [...byRank].sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranked.length; i++)
    assert.ok(ranked[i][1] > ranked[i - 1][1] + 120);
  for (const edge of aligned.edges!) {
    const source = byId.get(edge.sources[0].replace(":out", ""))!;
    const target = byId.get(edge.targets[0].replace(":in", ""))!;
    const section = edge.sections![0];
    assert.equal(section.startPoint.x, source.x! + 80);
    assert.equal(section.startPoint.y, source.y! + 120);
    assert.equal(section.endPoint.x, target.x! + 80);
    assert.equal(section.endPoint.y, target.y);
    const points = [
      section.startPoint,
      ...(section.bendPoints || []),
      section.endPoint,
    ];
    for (let i = 1; i < points.length; i++)
      assert.ok(
        points[i].x === points[i - 1].x || points[i].y === points[i - 1].y,
      );
  }
});
