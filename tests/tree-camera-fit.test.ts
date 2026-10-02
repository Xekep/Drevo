import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptUserNodes,
  getNodesInside,
  getViewportForBounds,
  type InternalNodeBase,
} from "@xyflow/system";
import {
  fitTreeNodes,
  treeFitBounds,
} from "../src/components/tree/tree-camera-fit.ts";

const node = (id: string, x: number, y: number, width = 220, height = 264) => ({
  id,
  position: { x, y },
  width,
  height,
  handles: [],
  data: {},
});
const canvas = { width: 900, height: 600 };

test("fresh offscreen public-port nodes fit without DOM measurements, including after data/selection changes", async () => {
  const first = [node("a", 5000, -400), node("b", 5500, 300)];
  type LayoutNode = (typeof first)[number];
  const lookup = new Map<string, InternalNodeBase<LayoutNode>>();
  const parents = new Map<string, Map<string, InternalNodeBase<LayoutNode>>>();
  assert.equal(adoptUserNodes(first, lookup, parents).nodesInitialized, false);
  assert.deepEqual(
    getNodesInside(lookup, { ...canvas, x: 0, y: 0 }, [0, 0, 1], true),
    [],
  );
  const calls: unknown[] = [];
  const flow = {
    viewportInitialized: true,
    setViewport: async (viewport: unknown, options: unknown) => {
      calls.push({ viewport, options });
      return true;
    },
  };
  assert.equal(
    await fitTreeNodes(flow, first, canvas, { maxZoom: 0.38, padding: 0.2 }),
    true,
  );
  assert.deepEqual(calls[0], {
    viewport: getViewportForBounds(
      { x: 5000, y: -400, width: 720, height: 964 },
      900,
      600,
      0.05,
      0.38,
      0.2,
    ),
    options: { duration: undefined, ease: undefined },
  });
  const changed = first.map((entry) => ({
    ...entry,
    selected: entry.id === "b",
    data: { hydrated: true },
  }));
  assert.equal(
    adoptUserNodes(changed, lookup, parents).nodesInitialized,
    false,
  );
  const ease = (value: number) => value ** 2;
  assert.equal(
    await fitTreeNodes(flow, changed, canvas, {
      ids: ["b"],
      minZoom: 0.55,
      maxZoom: 0.55,
      padding: 0.4,
      duration: 480,
      ease,
    }),
    true,
  );
  assert.deepEqual(calls[1], {
    viewport: getViewportForBounds(
      { x: 5500, y: 300, width: 220, height: 264 },
      900,
      600,
      0.55,
      0.55,
      0.4,
    ),
    options: { duration: 480, ease },
  });
  for (const entry of lookup.values())
    assert.equal(entry.measured.width, undefined);
  assert.deepEqual(first, [node("a", 5000, -400), node("b", 5500, 300)]);
});

test("fit boxes preserve custom sizes, renderer-hidden cards and household surfaces", () => {
  const nodes = [
    { ...node("a", -10.5, 20.25, 280, 320), hidden: true },
    node("household", -18.5, 12.25, 700, 336),
    node("siblings", -30, 380, 500, 90),
  ];
  assert.deepEqual(treeFitBounds(nodes), {
    x: -30,
    y: 12.25,
    width: 711.5,
    height: 457.75,
  });
  assert.deepEqual(treeFitBounds(nodes, ["a"]), {
    x: -10.5,
    y: 20.25,
    width: 280,
    height: 320,
  });
  assert.deepEqual(treeFitBounds(nodes, ["household"]), {
    x: -18.5,
    y: 12.25,
    width: 700,
    height: 336,
  });
});

test("exact occurrence targets stay exact; person targets use their present primary occurrence", () => {
  const nodes = [
    node("p", 0, 0),
    node("p:2", 2000, 100),
    node("q:1", 3000, 200),
  ];
  const occurrences = new Map([
    ["p", ["p", "p:2"]],
    ["q", ["missing", "q:1"]],
  ]);
  assert.deepEqual(treeFitBounds(nodes, ["p"], occurrences), {
    x: 0,
    y: 0,
    width: 220,
    height: 264,
  });
  assert.deepEqual(treeFitBounds(nodes, ["p:2"], occurrences), {
    x: 2000,
    y: 100,
    width: 220,
    height: 264,
  });
  assert.deepEqual(treeFitBounds(nodes, ["q"], occurrences), {
    x: 3000,
    y: 200,
    width: 220,
    height: 264,
  });
  assert.deepEqual(treeFitBounds(nodes, ["p", "q", "missing"], occurrences), {
    x: 0,
    y: 0,
    width: 3220,
    height: 464,
  });
});

test("uninitialized viewport, zero canvas and empty/missing targets never move the camera", async () => {
  let moved = 0;
  const flow = {
    viewportInitialized: false,
    setViewport: async () => {
      moved++;
      return true;
    },
  };
  const nodes = [node("a", 10, 20)];
  assert.equal(await fitTreeNodes(flow, nodes, canvas), false);
  flow.viewportInitialized = true;
  assert.equal(
    await fitTreeNodes(flow, nodes, { width: 0, height: 600 }),
    false,
  );
  assert.equal(await fitTreeNodes(flow, [], canvas), false);
  assert.equal(await fitTreeNodes(flow, nodes, canvas, { ids: [] }), false);
  assert.equal(
    await fitTreeNodes(flow, nodes, canvas, { ids: ["missing"] }),
    false,
  );
  assert.equal(moved, 0);
});
