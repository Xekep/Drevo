import test from "node:test";
import assert from "node:assert/strict";
import { compactFamilyLayout } from "../src/domain/family-packing.ts";
import type { ElkNode } from "elkjs";
import { layoutCost, layoutQuality } from "../src/domain/layout-quality.ts";

function drawing(width: number, height: number, detour = 0): ElkNode {
  return {
    id: "root",
    children: [
      { id: "a", x: 0, y: 0, width: 220, height: 96 },
      { id: "b", x: width - 220, y: height - 96, width: 220, height: 96 },
    ],
    edges: [
      {
        id: "ab",
        sources: ["a"],
        targets: ["b"],
        sections: [
          {
            id: "s",
            startPoint: { x: 110, y: 96 },
            endPoint: { x: width - 110, y: height - 96 },
            bendPoints: [
              { x: 110, y: height / 2 + detour },
              { x: width - 110, y: height / 2 + detour },
            ],
          },
        ],
      },
    ],
  };
}

test("a narrower layout is rejected when it wastes area and stretches a family connection", async () => {
  const baseline = drawing(4800, 2300);
  for (const detour of [0, 3500]) {
    const narrower = drawing(4100, 3700, detour);
    const result = await compactFamilyLayout(baseline, async (request) =>
      structuredClone(
        request.layoutOptions?.["elk.layered.layering.strategy"]
          ? narrower
          : baseline,
      ),
    );
    assert.deepEqual(result, baseline);
  }
});

test("a broad tree may use several family rows when overall geometry improves", async () => {
  const baseline = drawing(20000, 500);
  const compact = drawing(5000, 2300);
  const result = await compactFamilyLayout(baseline, async (request) =>
    structuredClone(
      request.layoutOptions?.["elk.layered.layering.strategy"]
        ? compact
        : baseline,
    ),
  );
  assert.deepEqual(result, compact);
  assert.ok(layoutCost(layoutQuality(compact), layoutQuality(baseline)) < 1);
});

test("a moderately wide tree may fill vertical space when every route stays safe", async () => {
  const baseline = drawing(1800, 600);
  const compact = drawing(1200, 900);
  const attempts: string[] = [];
  const result = await compactFamilyLayout(baseline, async (request) => {
    const strategy =
      request.layoutOptions?.["elk.layered.layering.strategy"] || "baseline";
    attempts.push(strategy);
    return structuredClone(strategy === "MIN_WIDTH" ? compact : baseline);
  });

  assert.ok(attempts.includes("MIN_WIDTH"));
  assert.deepEqual(result, compact);
});

test("a compact result cannot silently drop an edge route or replace a person", async () => {
  const baseline = drawing(20000, 500);
  for (const damage of ["route", "person"]) {
    const candidate = drawing(5000, 2300);
    if (damage === "route") candidate.edges![0].sections = [];
    else candidate.children![1].id = "unexpected-person";
    assert.deepEqual(
      await compactFamilyLayout(baseline, async (request) =>
        structuredClone(
          request.layoutOptions?.["elk.layered.layering.strategy"]
            ? candidate
            : baseline,
        ),
      ),
      baseline,
    );
  }
});

test("a compact layout with new crossings is rejected; a shared family trunk is not a crossing", async () => {
  const baseline = drawing(20000, 500),
    candidate = drawing(5000, 2300);
  const other = {
    id: "other",
    sources: ["c"],
    targets: ["d"],
    sections: [
      {
        id: "s2",
        startPoint: { x: 600, y: 1000 },
        endPoint: { x: 600, y: 1300 },
      },
    ],
  };
  for (const g of [baseline, candidate]) {
    g.children!.push(
      { id: "c", x: 700, y: 0, width: 220, height: 96 },
      { id: "d", x: 950, y: 0, width: 220, height: 96 },
    );
    g.edges!.push(structuredClone(other));
  }
  assert.equal(layoutQuality(baseline).crossedRoutes, 0);
  assert.equal(layoutQuality(candidate).crossedRoutes, 1);
  assert.deepEqual(
    await compactFamilyLayout(baseline, async (request) =>
      structuredClone(
        request.layoutOptions?.["elk.layered.layering.strategy"]
          ? candidate
          : baseline,
      ),
    ),
    baseline,
  );
  candidate.edges![1].sources = ["a"];
  assert.equal(layoutQuality(candidate).crossedRoutes, 0);
});

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
