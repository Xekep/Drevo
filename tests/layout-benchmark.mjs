// Run with: node --experimental-strip-types tests/layout-benchmark.mjs
// Set DREVO_LAYOUT_RANDOM_SCAN=1 to compare 24 deterministic family graphs.
// DREVO_LAYOUT_FAST=1 omits experimental ELK variants during that scan.
// DREVO_LAYOUT_EDIT_SCAN=1 measures movement after adding one small family.
// DREVO_LAYOUT_COMPONENT_SCAN=1 separates component drift from internal drift.
// DREVO_LAYOUT_ANCESTOR_SCAN=1 checks movement when adding a founder's parent.
// DREVO_LAYOUT_LARGE=1 adds two generations; DREVO_LAYOUT_LIMIT caps scans.
// DREVO_LAYOUT_SCALE_SCAN=1 measures geometry with production card dimensions.
// DREVO_LAYOUT_CASE selects a scale fixture (1-12, or opt-in 13: 1820 / 14: 2750 people).
// DREVO_LAYOUT_SEED_ONLY=1 measures only the first ELK candidate in scale mode.
// DREVO_LAYOUT_THOROUGHNESS=4 compares an ELK sweep budget in scale mode.
// DREVO_LAYOUT_MAX_ELK_CALLS=2 bounds candidate calls during a scale comparison.
// DREVO_LAYOUT_PAIR_SCAN=1 compares production layouts with couple flips.
// DREVO_LAYOUT_DISABLE_PAIR_FLIP=1 benchmarks the prior couple order.
// DREVO_LAYOUT_PRODUCTION_SCAN=1 measures one production layout per fixture.
// DREVO_ELK_BUNDLE can point to a local elkjs bundle without installed dependencies.
// DREVO_LAYOUT_ELK_OPTIONS is a JSON object of scalar ELK option overrides.
// Example: {"elk.layered.considerModelOrder.strategy":"NONE"}.
// DREVO_LAYOUT_GENERATION_MODE=partition|preset selects an explicit scale/prod comparison.
// DREVO_LAYOUT_TRACE=1 includes each ELK input/result trace in scale output.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { unionGeometry } from "../src/domain/union-layout.ts";
import { fromSketchUnionGraph, siftUnionOrder } from "../src/domain/union-order.ts";
import { routingQuality } from "../src/domain/routing-quality.ts";
import {
  bounds,
  segmentContact,
  segmentHitsBox,
  Spatial,
} from "../src/domain/edge-routing.ts";
import { TREE_NODE_HEIGHT, TREE_NODE_WIDTH, treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import {
  editedAncestorFamily,
  editedFamily,
  person,
  randomFamily,
} from "./layout-fixtures.ts";

const { default: ELK } = await import(
  process.env.DREVO_ELK_BUNDLE || "elkjs/lib/elk.bundled.js"
);
const optionOverrides = (() => {
  if (!process.env.DREVO_LAYOUT_ELK_OPTIONS) return {};
  const value = JSON.parse(process.env.DREVO_LAYOUT_ELK_OPTIONS);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("DREVO_LAYOUT_ELK_OPTIONS must be a JSON object");
  for (const [key, option] of Object.entries(value))
    if (!key || !["string", "number", "boolean"].includes(typeof option) ||
        (typeof option === "number" && !Number.isFinite(option)))
      throw new Error(`Invalid scalar ELK option override: ${key}`);
  return Object.fromEntries(Object.entries(value).map(([key, value]) => [key, String(value)]));
})();
const generationMode = process.env.DREVO_LAYOUT_GENERATION_MODE || "production";
if (!["production", "partition", "preset"].includes(generationMode))
  throw new Error("DREVO_LAYOUT_GENERATION_MODE must be production, partition or preset");
if (generationMode === "partition" && !process.env.DREVO_LAYOUT_SCALE_SCAN && !process.env.DREVO_LAYOUT_PRODUCTION_SCAN)
  throw new Error("Partition baseline is restricted to fresh scale/production scans");
const presetGenerationLayers = generationMode === "preset"
  ? (await import("../src/domain/union-layers.ts")).presetGenerationLayers : undefined;

const seeds = [1, 15, 20, 12, 4, 8];
const demo = JSON.parse(
  await readFile(new URL("./fixtures/family.json", import.meta.url), "utf8"),
);
const remarriages = [
  person("a", [], ["b", "c", "d"]),
  person("b", [], ["a", "e"]),
  person("c", [], ["a"]),
  person("d", [], ["a"]),
  person("e", [], ["b"]),
  ...["ab", "ac", "ad", "be"].flatMap((family) =>
    Array.from({ length: 3 }, (_, index) =>
      person(`${family}${index}`, [...family]),
    ),
  ),
];
const wide = [person("a", [], ["b"]), person("b", [], ["a"])];
for (let index = 0; index < 16; index++) {
  const child = `c${index}`;
  const spouse = `s${index}`;
  wide.push(person(child, ["a", "b"], [spouse]));
  wide.push(person(spouse, [], [child]));
  for (let grandchild = 0; grandchild < 3; grandchild++)
    wide.push(person(`g${index}-${grandchild}`, [child, spouse]));
}
const interwoven = Array.from({ length: 12 }, (_, index) =>
  person(`founder-${index}`),
);
const byId = new Map(interwoven.map((entry) => [entry.id, entry]));
const marry = (left, right) => {
  byId.get(left).spouses.push(right);
  byId.get(right).spouses.push(left);
};
for (let index = 0; index < 12; index += 2) {
  marry(`founder-${index}`, `founder-${index + 1}`);
  for (let child = 0; child < 4; child++) {
    const entry = person(`child-${index / 2}-${child}`, [
      `founder-${index}`,
      `founder-${index + 1}`,
    ]);
    interwoven.push(entry);
    byId.set(entry.id, entry);
  }
}
const generation = interwoven.slice(12).map((entry) => entry.id);
for (let index = 0; index < 12; index++) {
  const left = generation[index];
  const right = generation[23 - index];
  marry(left, right);
  for (let child = 0; child < 2; child++) {
    const entry = person(`grandchild-${index}-${child}`, [left, right]);
    interwoven.push(entry);
    byId.set(entry.id, entry);
  }
}

const cases = [
  ["demo", demo.people.map(({ id, birth, parents, spouses }) => ({
    id,
    birth,
    parents,
    spouses,
  }))],
  ["remarriages", remarriages],
  ["wide", wide],
  ["interwoven", interwoven],
];

function orderedGraph(graph, influence) {
  if (influence === "sift" || influence === "sift-force")
    return siftUnionOrder(graph, influence === "sift-force");
  const nodes = graph.children || [];
  const byPort = new Map(nodes.flatMap((node) =>
    (node.ports || []).map((port) => [port.id, node.id]),
  ));
  const predecessors = new Map(nodes.map((node) => [node.id, []]));
  const successors = new Map(nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges || []) {
    const source = byPort.get(edge.sources?.[0]);
    const target = byPort.get(edge.targets?.[0]);
    if (!source || !target || source === target) continue;
    predecessors.get(target).push(source);
    successors.get(source).push(target);
  }
  const depth = new Map();
  const pending = new Map(nodes.map((node) => [
    node.id,
    predecessors.get(node.id).length,
  ]));
  const queue = nodes.filter((node) => pending.get(node.id) === 0);
  for (const node of queue) depth.set(node.id, 0);
  for (let index = 0; index < queue.length; index++) {
    const node = queue[index];
    for (const next of successors.get(node.id)) {
      depth.set(next, Math.max(depth.get(next) || 0, depth.get(node.id) + 1));
      pending.set(next, pending.get(next) - 1);
      if (pending.get(next) === 0) queue.push(nodes.find((item) => item.id === next));
    }
  }
  const layers = new Map();
  for (const node of nodes) {
    const rank = depth.get(node.id) || 0;
    const layer = layers.get(rank) || [];
    layer.push(node);
    layers.set(rank, layer);
  }
  const ranks = [...layers.keys()].sort((a, b) => a - b);
  for (let pass = 0; pass < 4; pass++) {
    const down = pass % 2 === 0;
    for (const rank of down ? ranks.slice(1) : ranks.slice(0, -1).reverse()) {
      const layer = layers.get(rank);
      const adjacent = layers.get(rank + (down ? -1 : 1));
      const index = new Map(adjacent.map((node, position) => [node.id, position]));
      const previous = new Map(layer.map((node, position) => [node.id, position]));
      const neighbors = down ? predecessors : successors;
      const center = (node) => {
        const values = neighbors.get(node.id)
          .map((id) => index.get(id))
          .filter((value) => value !== undefined)
          .sort((a, b) => a - b);
        return values.length
          ? values[Math.floor((values.length - 1) / 2)]
          : previous.get(node.id);
      };
      layer.sort((a, b) =>
        center(a) - center(b) || previous.get(a.id) - previous.get(b.id),
      );
    }
  }
  return {
    ...graph,
    children: ranks.flatMap((rank) => layers.get(rank)),
    layoutOptions: {
      ...graph.layoutOptions,
      "elk.layered.considerModelOrder.crossingCounterNodeInfluence":
        String(influence === "force" ? 1 : influence),
      ...(influence === "force"
        ? { "elk.layered.crossingMinimization.forceNodeModelOrder": "true" }
        : {}),
    },
  };
}

function quality(geometry, people) {
  const { width: cardWidth, height: cardHeight } = geometry.nodeSize || {
    width: TREE_NODE_WIDTH,
    height: TREE_NODE_HEIGHT,
  };
  const finitePoint = (point) => Number.isFinite(point.x) && Number.isFinite(point.y);
  const allPositions = geometry.positions.map(([, point]) => point);
  // Invalid coordinates must be reported before they can enter an unbounded spatial query.
  const positions = allPositions.filter(finitePoint);
  const left = positions.length ? Math.min(...positions.map((point) => point.x)) : 0;
  const right = positions.length ? Math.max(...positions.map((point) => point.x)) + cardWidth : 0;
  const top = positions.length ? Math.min(...positions.map((point) => point.y)) : 0;
  const bottom = positions.length ? Math.max(...positions.map((point) => point.y)) + cardHeight : 0;
  const cards = new Spatial();
  let cardOverlaps = 0;
  for (const point of positions) {
    const card = {
      left: point.x,
      right: point.x + cardWidth,
      top: point.y,
      bottom: point.y + cardHeight,
    };
    cardOverlaps += cards.query(card).filter((other) =>
      card.left < other.right && card.right > other.left &&
      card.top < other.bottom && card.bottom > other.top).length;
    cards.add(card);
  }
  const allRoutes = [
    ...(geometry.branches || []).map((branch) => ({
      group: branch.union,
      route: branch.route,
    })),
    ...(geometry.routes || []).map(([id, route]) => ({ group: id, route })),
  ];
  const routes = allRoutes.filter(({ route }) => route.points.every(finitePoint));
  const validBranches = (geometry.branches || []).filter((branch) => branch.route.points.every(finitePoint));
  let cardHits = 0, diagonalSegments = 0;
  for (const { route } of routes)
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1];
      const b = route.points[index];
      if (a.x !== b.x && a.y !== b.y) diagonalSegments++;
      cardHits += cards
        .query(bounds(a, b))
        .filter((card) => segmentHitsBox(a, b, card)).length;
    }
  const routing = routingQuality(routes);
  const branchContacts = routingQuality(validBranches.map((branch) => ({
    group: branch.union,
    route: branch.route,
  }))).contacts;
  const segments = new Spatial();
  let rawContacts = 0;
  for (const branch of validBranches) {
    const points = branch.route.points;
    for (let index = 1; index < points.length; index++) {
      const a = points[index - 1];
      const b = points[index];
      if (a.x === b.x && a.y === b.y) continue;
      const box = bounds(a, b);
      for (const other of segments.query(box))
        if (
          branch.union !== other.union &&
          segmentContact(a, b, other.a, other.b)
        )
          rawContacts++;
      segments.add({ ...box, a, b, union: branch.union });
    }
  }
  const relationKey = ({ type, from, to }) => JSON.stringify(type === "spouse"
    ? [type, ...[from, to].sort()] : [type, from, to]);
  const coveredRelations = new Set((geometry.branches || []).flatMap((branch) =>
    branch.relations.map(relationKey)));
  const parents = new Set(people.flatMap((person) => person.parents.map((from) =>
    relationKey({ type: "parent", from, to: person.id }))));
  const spouses = new Set(people.flatMap((person) => person.spouses.map((to) =>
    relationKey({ type: "spouse", from: person.id, to }))));
  const coveredPeople = new Set((geometry.occurrences || []).map((item) => item.personId));
  return {
    contacts: routing.contacts,
    branchContacts,
    rawContacts,
    crossings: routing.crossings,
    cardHits,
    cardOverlaps,
    diagonalSegments,
    nonFinitePositions: allPositions.length - positions.length,
    nonFiniteRoutePoints: allRoutes.reduce((count, { route }) => count + route.points.filter((point) => !finitePoint(point)).length, 0),
    missingPeople: people.filter((person) => !coveredPeople.has(person.id)).length,
    missingParentRelations: [...parents].filter((key) => !coveredRelations.has(key)).length,
    missingSpouseRelations: [...spouses].filter((key) => !coveredRelations.has(key)).length,
    length: routing.length,
    bends: routing.bends,
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

/** Estimate partition expansion within the components ELK actually separates. */
function graphTrace(graph) {
  const nodes = graph.children || [], edges = graph.edges || [];
  const owners = new Map(nodes.map((node) => [node.id, node.id]));
  const byPort = new Map(nodes.flatMap((node) =>
    (node.ports || []).map((port) => [port.id, node.id])));
  const owner = (id) => byPort.get(id) || id;
  const find = (id) => {
    let root = id;
    while (owners.get(root) !== root) root = owners.get(root);
    while (id !== root) { const next = owners.get(id); owners.set(id, root); id = next; }
    return root;
  };
  for (const edge of edges)
    for (const source of edge.sources || [])
      for (const target of edge.targets || [])
        if (owners.has(owner(source)) && owners.has(owner(target)))
          owners.set(find(owner(target)), find(owner(source)));
  const components = new Map(), ranks = new Map();
  for (const node of nodes) {
    const key = graph.layoutOptions?.["elk.separateConnectedComponents"] === "false" ? "all" : find(node.id);
    const list = components.get(key) || [];
    list.push(node); components.set(key, list);
    const rank = Number(node.layoutOptions?.["elk.partitioning.partition"]);
    if (Number.isInteger(rank)) ranks.set(rank, (ranks.get(rank) || 0) + 1);
  }
  let partitionDummyPairEstimate = 0;
  if (graph.layoutOptions?.["elk.partitioning.activate"] === "true")
    for (const members of components.values()) {
      const counts = new Map();
      for (const node of members) {
        const rank = Number(node.layoutOptions?.["elk.partitioning.partition"]);
        if (Number.isInteger(rank)) counts.set(rank, (counts.get(rank) || 0) + 1);
      }
      const ordered = [...counts].sort((a, b) => a[0] - b[0]);
      for (let index = 1; index < ordered.length; index++)
        partitionDummyPairEstimate += ordered[index - 1][1] * ordered[index][1];
    }
  return {
    components,
    inputNodes: nodes.length, inputEdges: edges.length,
    inputPorts: byPort.size,
    componentsCount: components.size,
    rankWidths: [...ranks].sort((a, b) => a[0] - b[0]),
    partitionDummyPairEstimate,
  };
}

function rankValidity(result, components) {
  const actual = new Map((result.children || []).map((node) => [node.id, node]));
  let missingElkNodes = 0, nonFiniteElkPositions = 0, sameRankYViolations = 0, rankOrderViolations = 0;
  for (const members of components.values()) {
    const rows = new Map();
    for (const node of members) {
      const placed = actual.get(node.id);
      if (!placed) { missingElkNodes++; continue; }
      if (!Number.isFinite(placed.x) || !Number.isFinite(placed.y)) { nonFiniteElkPositions++; continue; }
      const rank = Number(node.layoutOptions?.["elk.partitioning.partition"]);
      const row = rows.get(rank) || [];
      row.push(placed.y); rows.set(rank, row);
    }
    const ordered = [...rows].sort((a, b) => a[0] - b[0]);
    for (const [, ys] of ordered)
      sameRankYViolations += ys.filter((y) => Math.abs(y - ys[0]) > 1e-6).length;
    for (let index = 1; index < ordered.length; index++)
      if (Math.min(...ordered[index][1]) <= Math.max(...ordered[index - 1][1])) rankOrderViolations++;
  }
  return { missingElkNodes, nonFiniteElkPositions, sameRankYViolations, rankOrderViolations };
}

async function measure(people, selectedSeed, influence, thoroughness, disableCompact = false, interactiveFrom, previousGeometry, size, skipPairFlip = false) {
  const engine = new ELK({ algorithms: ["layered"] });
  let elkCalls = 0;
  let elkMs = 0;
  const trace = [];
  const completedSeeds = new Set();
  const layout = async (graph) => {
    const seed = Number(graph.layoutOptions?.["elk.randomSeed"]);
    if (disableCompact && graph.layoutOptions?.["elk.layered.layering.strategy"] === "MIN_WIDTH")
      throw new Error("skip compact benchmark candidate");
    // The benchmark's single-seed runs reject later candidates before ELK.
    if (selectedSeed !== undefined && seed !== 1)
      throw new Error("skip other benchmark seeds");
    if (skipPairFlip && completedSeeds.has(seed))
      throw new Error("skip pair flip benchmark candidate");
    if (process.env.DREVO_LAYOUT_MAX_ELK_CALLS &&
        elkCalls >= Number(process.env.DREVO_LAYOUT_MAX_ELK_CALLS))
      throw new Error("skip later benchmark candidates");
    const input = selectedSeed === undefined
      ? graph
      : {
          ...graph,
          layoutOptions: {
            ...graph.layoutOptions,
            "elk.randomSeed": String(selectedSeed),
          },
        };
    const prepared = influence === undefined
      ? input
      : orderedGraph(input, influence);
    const tuned = thoroughness === undefined
      ? prepared
      : {
          ...prepared,
          layoutOptions: {
            ...prepared.layoutOptions,
            "elk.layered.thoroughness": String(thoroughness),
          },
        };
    let finalGraph = interactiveFrom ? fromSketchUnionGraph(tuned, interactiveFrom) || tuned : tuned;
    if (generationMode === "partition") {
      if (previousGeometry || interactiveFrom) throw new Error("Partition baseline cannot erase previous geometry hints");
      finalGraph = {
        ...finalGraph,
        children: (finalGraph.children || []).map((entry) => {
          const node = { ...entry, layoutOptions: { ...entry.layoutOptions } };
          delete node.x; delete node.y; delete node.layoutOptions["elk.position"];
          return node;
        }),
        layoutOptions: { ...finalGraph.layoutOptions,
          "elk.partitioning.activate": "true",
          "elk.layered.layering.strategy": "NETWORK_SIMPLEX" },
      };
    } else if (presetGenerationLayers) finalGraph = presetGenerationLayers(finalGraph);
    if (Object.keys(optionOverrides).length)
      finalGraph = { ...finalGraph, layoutOptions: { ...finalGraph.layoutOptions, ...optionOverrides } };
    const { components, ...inputTrace } = graphTrace(finalGraph);
    const inputOptions = { ...finalGraph.layoutOptions };
    const started = performance.now();
    let elapsed;
    try {
      const result = await engine.layout(finalGraph);
      elapsed = performance.now() - started;
      completedSeeds.add(seed);
      trace.push({
        ...inputTrace,
        options: inputOptions,
        seed: inputOptions["elk.randomSeed"],
        strategy: inputOptions["elk.layered.layering.strategy"] || "default",
        bound: inputOptions["elk.layered.layering.minWidth.upperBoundOnWidth"],
        width: Math.round(result.width || 0),
        height: Math.round(result.height || 0),
        ...rankValidity(result, components),
        ms: Math.round(elapsed),
      });
      return result;
    } catch (error) {
      elapsed ??= performance.now() - started;
      trace.push({ ...inputTrace, options: inputOptions,
        ms: Math.round(elapsed), error: String(error) });
      throw error;
    } finally {
      elkCalls++;
      elkMs += elapsed ?? performance.now() - started;
    }
  };
  const started = performance.now();
  let geometry, layoutCompleted;
  try {
    geometry = await unionGeometry(people, layout, false, [], size, previousGeometry);
    layoutCompleted = performance.now();
  } finally {
    // Bundled ELK uses an in-process FakeWorker without a terminate method.
    if (typeof engine.worker?.worker?.terminate === "function")
      await engine.terminateWorker();
  }
  const qualityStarted = performance.now();
  const measuredQuality = quality(geometry, people);
  const qualityCompleted = performance.now();
  const result = {
    seed: thoroughness !== undefined
      ? `thoroughness ${thoroughness}`
      : influence === undefined
        ? selectedSeed ?? "production"
        : `median ${influence}`,
    ...measuredQuality,
    elkCalls,
    elkMs: Math.round(elkMs),
    layoutMs: Math.round(layoutCompleted - started),
    qualityMs: Math.round(qualityCompleted - qualityStarted),
    // Harness wall time includes quality checks and engine disposal. Constructor/module import is excluded.
    totalMs: Math.round(qualityCompleted - started),
    generationMode,
    geometrySha256: createHash("sha256").update(JSON.stringify(geometry)).digest("hex"),
  };
  Object.defineProperty(result, "geometry", { value: geometry });
  Object.defineProperty(result, "trace", { value: trace });
  return result;
}

function displacement(before, after) {
  const previous = new Map(before.positions);
  const pairs = after.positions
    .filter(([id]) => previous.has(id))
    .map(([id, point]) => [previous.get(id).x, point.x]);
  if (!pairs.length) return 0;
  const shifts = pairs.map(([oldX, newX]) => newX - oldX).sort((a, b) => a - b);
  const shift = shifts[Math.floor(shifts.length / 2)];
  return Math.round(pairs.reduce((sum, [oldX, newX]) =>
    sum + Math.abs(newX - oldX - shift), 0) / pairs.length);
}

function verticalDisplacement(before, after) {
  const previous = new Map(before.positions);
  const shifts = after.positions
    .filter(([id]) => previous.has(id))
    .map(([id, point]) => point.y - previous.get(id).y)
    .sort((a, b) => a - b);
  if (!shifts.length) return 0;
  const center = shifts[Math.floor(shifts.length / 2)];
  return Math.round(shifts.reduce((sum, shift) => sum + Math.abs(shift - center), 0) / shifts.length);
}

function componentMotion(before, after, people) {
  const root = new Map(people.map((entry) => [entry.id, entry.id]));
  const find = (id) => {
    let current = id;
    while (root.get(current) !== current) current = root.get(current);
    while (root.get(id) !== current) {
      const next = root.get(id);
      root.set(id, current);
      id = next;
    }
    return current;
  };
  for (const entry of people)
    for (const relative of [...entry.parents, ...entry.spouses])
      if (root.has(relative)) root.set(find(entry.id), find(relative));
  const personOf = new Map((after.occurrences || []).map((item) =>
    [item.id, item.personId]));
  const previous = new Map(before.positions);
  const shifts = new Map();
  for (const [id, point] of after.positions) {
    const old = previous.get(id);
    if (!old) continue;
    const family = find(personOf.get(id) || id);
    const list = shifts.get(family) || [];
    list.push(point.x - old.x);
    shifts.set(family, list);
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const all = [...shifts.values()].flat();
  if (!all.length) return { components: 0, global: 0, internal: 0 };
  const globalShift = median(all);
  const global = all.reduce((sum, shift) => sum + Math.abs(shift - globalShift), 0) / all.length;
  let internal = 0;
  for (const values of shifts.values()) {
    const center = median(values);
    internal += values.reduce((sum, shift) => sum + Math.abs(shift - center), 0);
  }
  return {
    components: shifts.size,
    largest: Math.max(...[...shifts.values()].map((values) => values.length)),
    global: Math.round(global),
    internal: Math.round(internal / all.length),
  };
}

function orderMotion(before, after) {
  const previous = new Map(before.positions);
  const pairs = after.positions
    .filter(([id]) => previous.has(id))
    .map(([id, point]) => [previous.get(id), point]);
  const verticalShifts = pairs.map(([old, next]) => next.y - old.y).sort((a, b) => a - b);
  const verticalShift = verticalShifts[Math.floor(verticalShifts.length / 2)] || 0;
  let comparisons = 0, inversions = 0;
  for (let index = 0; index < pairs.length; index++)
    for (let other = 0; other < index; other++) {
      const [a, b] = pairs[index], [c, d] = pairs[other];
      if (a.y !== c.y || b.y !== d.y) continue;
      comparisons++;
      if ((a.x - c.x) * (b.x - d.x) < 0) inversions++;
    }
  return {
    rowChanges: pairs.filter(([old, next]) =>
      Math.abs(next.y - old.y - verticalShift) > TREE_NODE_HEIGHT / 2).length,
    inversions,
    comparisons,
  };
}

if (process.env.DREVO_LAYOUT_PRODUCTION_SCAN) {
  const limit = Number(process.env.DREVO_LAYOUT_LIMIT || 24);
  for (let seed = 1; seed <= limit; seed++) {
    const people = randomFamily(seed, process.env.DREVO_LAYOUT_LARGE ? 4 : 2);
    const result = await measure(people, undefined, undefined, undefined,
      false, undefined, undefined, treeNodeSize());
    console.log(JSON.stringify({ seed, people: people.length,
      contacts: result.contacts, crossings: result.crossings,
      cardHits: result.cardHits, width: result.width,
      elkCalls: result.elkCalls, elkMs: result.elkMs, layoutMs: result.layoutMs,
      qualityMs: result.qualityMs, totalMs: result.totalMs,
      cardOverlaps: result.cardOverlaps, nonFinitePositions: result.nonFinitePositions,
      nonFiniteRoutePoints: result.nonFiniteRoutePoints,
      missingPeople: result.missingPeople,
      missingParentRelations: result.missingParentRelations,
      missingSpouseRelations: result.missingSpouseRelations,
      generationMode: result.generationMode, geometrySha256: result.geometrySha256,
      ...(process.env.DREVO_LAYOUT_TRACE ? { trace: result.trace } : {}) }));
  }
} else if (process.env.DREVO_LAYOUT_PAIR_SCAN) {
  const limit = Number(process.env.DREVO_LAYOUT_LIMIT || 24);
  for (let seed = 1; seed <= limit; seed++) {
    const people = randomFamily(seed, 2);
    const base = await measure(people, undefined, undefined, undefined, false, undefined, undefined, treeNodeSize(), true);
    const trial = await measure(people, undefined, undefined, undefined, false, undefined, undefined, treeNodeSize());
    const before = new Map(base.geometry.positions);
    const after = new Map(trial.geometry.positions);
    const swapped = trial.geometry.blocks.filter((block) => block.members.length === 2 &&
      block.members.every((id) => before.has(id)) &&
      Math.sign(before.get(block.members[0]).x - before.get(block.members[1]).x) !==
        Math.sign(after.get(block.members[0]).x - after.get(block.members[1]).x)).length;
    console.log(JSON.stringify({ seed, people: people.length, swapped,
      beforeContacts: base.contacts, afterContacts: trial.contacts,
      beforeCrossings: base.crossings, afterCrossings: trial.crossings,
      extraElkCalls: trial.elkCalls - base.elkCalls,
      beforeMs: base.totalMs, afterMs: trial.totalMs }));
  }
} else if (process.env.DREVO_LAYOUT_SCALE_SCAN) {
  const fixtures = [[1, 2], [1, 4], [1, 5], [1, 6], [1, 7], [5, 9], [1, 8], [2, 6], [3, 6], [4, 7], [10, 9], [8, 9], [1, 9], [1, 10]];
  for (const [index, [seed, generations]] of fixtures.entries()) {
    // Do not add multi-thousand-person work to existing scans without an explicit case.
    if (index >= 12 && !process.env.DREVO_LAYOUT_CASE) continue;
    if (process.env.DREVO_LAYOUT_CASE && Number(process.env.DREVO_LAYOUT_CASE) !== index + 1) continue;
    const people = randomFamily(seed, generations);
    const selectedSeed = process.env.DREVO_LAYOUT_SEED_ONLY ? 1 : undefined;
    const skipPairFlip = process.env.DREVO_LAYOUT_DISABLE_PAIR_FLIP === "1";
    const thoroughness = process.env.DREVO_LAYOUT_THOROUGHNESS
      ? Number(process.env.DREVO_LAYOUT_THOROUGHNESS) : undefined;
    const result = await measure(people, selectedSeed, undefined, thoroughness, false, undefined, undefined, treeNodeSize(), skipPairFlip);
    const geometry = result.geometry;
    console.log(JSON.stringify({
      case: index + 1,
      people: people.length,
      seed,
      generations,
      occurrences: geometry.positions.length,
      missingPeople: result.missingPeople,
      missingParentRelations: result.missingParentRelations,
      missingSpouseRelations: result.missingSpouseRelations,
      nonFinitePositions: result.nonFinitePositions,
      nonFiniteRoutePoints: result.nonFiniteRoutePoints,
      cardOverlaps: result.cardOverlaps,
      diagonalSegments: result.diagonalSegments,
      branches: geometry.branches?.length || 0,
      contacts: result.contacts,
      branchContacts: result.branchContacts,
      crossings: result.crossings,
      length: Math.round(result.length),
      bends: result.bends,
      cardHits: result.cardHits,
      width: result.width,
      height: result.height,
      elkCalls: result.elkCalls,
      elkMs: result.elkMs,
      totalMs: result.totalMs,
      layoutMs: result.layoutMs,
      qualityMs: result.qualityMs,
      generationMode: result.generationMode,
      geometrySha256: result.geometrySha256,
      ...(process.env.DREVO_LAYOUT_TRACE ? { trace: result.trace } : {}),
    }));
  }
} else if (process.env.DREVO_LAYOUT_COMPONENT_SCAN || process.env.DREVO_LAYOUT_ANCESTOR_SCAN) {
  const summary = [];
  const selectedCase = Number(process.env.DREVO_LAYOUT_CASE || 0);
  const lastCase = selectedCase || Number(process.env.DREVO_LAYOUT_LIMIT || 24);
  for (let index = selectedCase || 1; index <= lastCase; index++) {
    const original = randomFamily(index, process.env.DREVO_LAYOUT_LARGE ? 4 : 2);
    const edited = process.env.DREVO_LAYOUT_ANCESTOR_SCAN
      ? editedAncestorFamily(original, index)
      : editedFamily(original, index);
    const before = await measure(original);
    const after = await measure(edited);
    const plain = await measure(edited, undefined, undefined, undefined, true);
    const interactive = await measure(edited, 1, undefined, undefined, true, before.geometry);
    const incremental = await measure(edited, undefined, undefined, undefined, false, undefined, before.geometry);
    const plainMotion = componentMotion(before.geometry, plain.geometry, edited);
    summary.push({
      case: index,
      beforeSize: `${before.width}×${before.height}`,
      afterSize: `${after.width}×${after.height}`,
      ...componentMotion(before.geometry, after.geometry, edited),
      ...orderMotion(before.geometry, after.geometry),
      plainSize: `${plain.width}×${plain.height}`,
      plainContacts: plain.branchContacts,
      currentContacts: after.branchContacts,
      plainDrift: plainMotion.global,
      interactiveSize: `${interactive.width}×${interactive.height}`,
      interactiveContacts: interactive.branchContacts,
      interactiveAllContacts: interactive.contacts,
      interactiveRaw: interactive.rawContacts,
      interactiveCrossings: interactive.crossings,
      interactiveCardHits: interactive.cardHits,
      interactiveLength: Math.round(interactive.length),
      interactiveBends: interactive.bends,
      interactiveDrift: componentMotion(before.geometry, interactive.geometry, edited).global,
      interactiveVertical: verticalDisplacement(before.geometry, interactive.geometry),
      incrementalSize: `${incremental.width}×${incremental.height}`,
      incrementalContacts: incremental.branchContacts,
      currentRaw: after.rawContacts,
      currentCrossings: after.crossings,
      incrementalCrossings: incremental.crossings,
      currentAllContacts: after.contacts,
      incrementalAllContacts: incremental.contacts,
      currentCardHits: after.cardHits,
      incrementalCardHits: incremental.cardHits,
      currentLength: Math.round(after.length),
      currentBends: after.bends,
      incrementalLength: Math.round(incremental.length),
      incrementalBends: incremental.bends,
      incrementalDrift: componentMotion(before.geometry, incremental.geometry, edited).global,
      currentVertical: verticalDisplacement(before.geometry, after.geometry),
      incrementalVertical: verticalDisplacement(before.geometry, incremental.geometry),
      incrementalRows: orderMotion(before.geometry, incremental.geometry).rowChanges,
      incrementalCalls: incremental.elkCalls,
      currentMs: after.totalMs,
      incrementalMs: incremental.totalMs,
    });
    if (selectedCase)
      console.log(JSON.stringify({ case: index, before: before.trace, after: after.trace }));
  }
  console.table(summary);
  if (selectedCase) console.log(JSON.stringify(summary[0]));
  console.log("Mean drift:",
    Math.round(summary.reduce((sum, row) => sum + row.global, 0) / summary.length),
    "px overall /",
    Math.round(summary.reduce((sum, row) => sum + row.internal, 0) / summary.length),
    "px within family components");
  console.log("Incremental candidate:",
    summary.filter((row) => row.incrementalDrift < row.global).length,
    "edits stabilized; mean drift",
    Math.round(summary.reduce((sum, row) => sum + row.incrementalDrift, 0) / summary.length),
    "px; contact regressions",
    summary.filter((row) => row.incrementalContacts > row.currentContacts).length);
} else if (process.env.DREVO_LAYOUT_EDIT_SCAN) {
  const summary = [];
  const selectedCase = Number(process.env.DREVO_LAYOUT_CASE || 0);
  const lastCase = selectedCase || Number(process.env.DREVO_LAYOUT_LIMIT || 24);
  for (let index = selectedCase || 1; index <= lastCase; index++) {
    const original = randomFamily(index, process.env.DREVO_LAYOUT_LARGE ? 4 : 2);
    const before = await measure(original);
    const edited = editedFamily(original, index);
    const variants = [];
    for (const seed of seeds) {
      const result = await measure(edited, seed);
      variants.push({
        ...result,
        movement: displacement(before.geometry, result.geometry),
      });
    }
    const forced = await measure(edited, 1, "force");
    if (selectedCase) console.log("seed-variants", JSON.stringify(variants.map((item) => ({
      seed: item.seed,
      contacts: item.branchContacts,
      raw: item.rawContacts,
      movement: item.movement,
      width: item.width,
      height: item.height,
    }))));
    const forcedMovement = displacement(before.geometry, forced.geometry);
    const initial = variants[0];
    const eligible = variants.filter((item) =>
      Math.max(item.width, item.height) <=
        Math.max(initial.width, initial.height) * 1.4 &&
      item.width * item.height <= initial.width * initial.height * 1.5);
    const current = eligible.reduce((best, item) =>
      item.branchContacts < best.branchContacts ||
      (item.branchContacts === best.branchContacts &&
        item.rawContacts < best.rawContacts) ? item : best, initial);
    const stable = eligible.filter((item) =>
      item.branchContacts <= current.branchContacts + 1 &&
      item.rawContacts <= current.rawContacts + 2).reduce((best, item) =>
        item.movement < best.movement ? item : best, current);
    summary.push({
      case: index,
      people: edited.length,
      contacts: current.branchContacts,
      currentSeed: current.seed,
      stableSeed: stable.seed,
      currentMovement: current.movement,
      stableMovement: stable.movement,
      currentRaw: current.rawContacts,
      stableRaw: stable.rawContacts,
      forcedContacts: forced.branchContacts,
      forcedMovement,
    });
  }
  console.table(summary);
  console.log("Movement improved in",
    summary.filter((row) => row.stableMovement < row.currentMovement).length,
    "of", summary.length, "edits with at most one extra contact");
} else if (process.env.DREVO_LAYOUT_RANDOM_SCAN) {
  const summary = [];
  const selectedCase = Number(process.env.DREVO_LAYOUT_CASE || 0);
  const lastCase = selectedCase || Number(process.env.DREVO_LAYOUT_LIMIT || 24);
  for (let index = selectedCase || 1; index <= lastCase; index++) {
    const people = randomFamily(index, process.env.DREVO_LAYOUT_LARGE ? 4 : 2);
    const results = [];
    for (const seed of seeds) results.push(await measure(people, seed));
    const median = process.env.DREVO_LAYOUT_FAST ? null : await measure(people, 1, 0.001);
    const sift = process.env.DREVO_LAYOUT_FAST ? null : await measure(people, 1, "sift");
    const siftForce = process.env.DREVO_LAYOUT_FAST ? null : await measure(people, 1, "sift-force");
    const thorough24 = process.env.DREVO_LAYOUT_FAST ? null : await measure(people, 1, undefined, 24);
    const thorough48 = process.env.DREVO_LAYOUT_FAST ? null : await measure(people, 1, undefined, 48);
    const production = await measure(people);
    const initial = results[0];
    const eligible = results.filter((result) =>
      Math.max(result.width, result.height) <=
        Math.max(initial.width, initial.height) * 1.4 &&
      result.width * result.height <= initial.width * initial.height * 1.5);
    const groupedPick = eligible.reduce((best, result) =>
      result.contacts < best.contacts ? result : best, initial);
    const branchPick = eligible.reduce((best, result) =>
      result.branchContacts < best.branchContacts ? result : best, initial);
    const rawPick = eligible.reduce((best, result) =>
      result.rawContacts < best.rawContacts ? result : best, initial);
    summary.push({
      case: index,
      people: people.length,
      contacts: results.map((result) => result.contacts).join(","),
      rawContacts: results.map((result) => result.rawContacts).join(","),
      widths: results.map((result) => result.width).join(","),
      heights: results.map((result) => result.height).join(","),
      lengths: results.map((result) => Math.round(result.length)).join(","),
      median: median?.contacts,
      sift: sift && `${sift.contacts}/${sift.rawContacts}`,
      siftForce: siftForce && `${siftForce.contacts}/${siftForce.rawContacts}`,
      thorough24: thorough24 && `${thorough24.contacts}/${thorough24.rawContacts}/${thorough24.width}/${thorough24.totalMs}`,
      thorough48: thorough48 && `${thorough48.contacts}/${thorough48.rawContacts}/${thorough48.width}/${thorough48.totalMs}`,
      production: `${production.contacts}/${production.width}×${production.height}`,
      productionBranch: `${production.branchContacts}/${production.rawContacts}/${production.width}`,
      groupedPick: `${groupedPick.contacts}/${groupedPick.rawContacts}/${groupedPick.width}`,
      branchPick: `${branchPick.contacts}/${branchPick.rawContacts}/${branchPick.width}`,
      rawPick: `${rawPick.contacts}/${rawPick.rawContacts}/${rawPick.width}`,
      seed8Ms: results[5].totalMs,
      siftMs: siftForce?.totalMs,
      productionCalls: production.elkCalls,
      bestLater: Math.min(...results.slice(1).map((result) => result.contacts)) <
        results[0].contacts,
    });
  }
  console.table(summary);
  console.log("Unique-contact selection:",
    summary.filter((row) => Number(row.branchPick.split("/")[0]) <
      Number(row.rawPick.split("/")[0])).length,
    "improved,",
    summary.filter((row) => Number(row.branchPick.split("/")[0]) >
      Number(row.rawPick.split("/")[0])).length,
    "worsened");
  console.log("Production versus six standard seeds:",
    summary.filter((row) => Number(row.productionBranch.split("/")[0]) <
      Number(row.branchPick.split("/")[0])).length, "improved,",
    summary.filter((row) => Number(row.productionBranch.split("/")[0]) >
      Number(row.branchPick.split("/")[0])).length, "worsened");
  if (!process.env.DREVO_LAYOUT_FAST)
    console.log("Median candidate time:",
      [...summary.map((row) => row.seed8Ms)].sort((a, b) => a - b)[12],
      "ms standard /",
      [...summary.map((row) => row.siftMs)].sort((a, b) => a - b)[12],
      "ms sift");
} else {
  for (const [name, people] of cases) {
    const results = [];
    for (const seed of seeds) results.push(await measure(people, seed));
    for (const influence of [0.001, 0.05, 0.5, "force", "sift", "sift-force"])
      results.push(await measure(people, 1, influence));
    results.push(await measure(people));
    console.log(`\n${name}: ${people.length} people`);
    console.table(results);
  }
}
