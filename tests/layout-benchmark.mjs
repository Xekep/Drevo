// Run with: node --experimental-strip-types tests/layout-benchmark.mjs
// Set DREVO_LAYOUT_RANDOM_SCAN=1 to compare 24 deterministic family graphs.
// DREVO_LAYOUT_FAST=1 omits experimental ELK variants during that scan.
// DREVO_LAYOUT_EDIT_SCAN=1 measures movement after adding one small family.
// DREVO_LAYOUT_COMPONENT_SCAN=1 separates component drift from internal drift.
// DREVO_LAYOUT_ANCESTOR_SCAN=1 checks movement when adding a founder's parent.
// DREVO_LAYOUT_CASE selects one graph; DREVO_ELK_BUNDLE can point to a local
// elkjs bundle when dependencies are not installed in this checkout.
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
import { TREE_NODE_HEIGHT, TREE_NODE_WIDTH } from "../src/domain/tree-layout-constants.ts";
import {
  editedAncestorFamily,
  editedFamily,
  person,
  randomFamily,
} from "./layout-fixtures.ts";

const { default: ELK } = await import(
  process.env.DREVO_ELK_BUNDLE || "elkjs/lib/elk.bundled.js"
);

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

function quality(geometry) {
  const positions = geometry.positions.map(([, point]) => point);
  const left = Math.min(...positions.map((point) => point.x));
  const right = Math.max(...positions.map((point) => point.x)) + TREE_NODE_WIDTH;
  const top = Math.min(...positions.map((point) => point.y));
  const bottom = Math.max(...positions.map((point) => point.y)) + TREE_NODE_HEIGHT;
  const cards = new Spatial();
  for (const point of positions)
    cards.add({
      left: point.x,
      right: point.x + TREE_NODE_WIDTH,
      top: point.y,
      bottom: point.y + TREE_NODE_HEIGHT,
    });
  const routes = [
    ...(geometry.branches || []).map((branch) => ({
      group: branch.union,
      route: branch.route,
    })),
    ...(geometry.routes || []).map(([id, route]) => ({ group: id, route })),
  ];
  let cardHits = 0;
  for (const { route } of routes)
    for (let index = 1; index < route.points.length; index++) {
      const a = route.points[index - 1];
      const b = route.points[index];
      cardHits += cards
        .query(bounds(a, b))
        .filter((card) => segmentHitsBox(a, b, card)).length;
    }
  const routing = routingQuality(routes);
  const branchContacts = routingQuality((geometry.branches || []).map((branch) => ({
    group: branch.union,
    route: branch.route,
  }))).contacts;
  const segments = new Spatial();
  let rawContacts = 0;
  for (const branch of geometry.branches || []) {
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
  return {
    contacts: routing.contacts,
    branchContacts,
    rawContacts,
    crossings: routing.crossings,
    cardHits,
    length: routing.length,
    bends: routing.bends,
    width: Math.round(right - left),
    height: Math.round(bottom - top),
  };
}

async function measure(people, selectedSeed, influence, thoroughness, disableCompact = false, interactiveFrom, previousGeometry) {
  const engine = new ELK({ algorithms: ["layered"] });
  let elkCalls = 0;
  let elkMs = 0;
  const trace = [];
  const layout = async (graph) => {
    const seed = Number(graph.layoutOptions?.["elk.randomSeed"]);
    if (disableCompact && graph.layoutOptions?.["elk.layered.layering.strategy"] === "MIN_WIDTH")
      throw new Error("skip compact benchmark candidate");
    // The benchmark's single-seed runs reject later candidates before ELK.
    if (selectedSeed !== undefined && seed !== 1)
      throw new Error("skip other benchmark seeds");
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
    const finalGraph = interactiveFrom ? fromSketchUnionGraph(tuned, interactiveFrom) || tuned : tuned;
    const started = performance.now();
    try {
      const result = await engine.layout(finalGraph);
      trace.push({
        seed: finalGraph.layoutOptions?.["elk.randomSeed"],
        strategy: finalGraph.layoutOptions?.["elk.layered.layering.strategy"] || "default",
        bound: finalGraph.layoutOptions?.["elk.layered.layering.minWidth.upperBoundOnWidth"],
        width: Math.round(result.width || 0),
        height: Math.round(result.height || 0),
      });
      return result;
    } finally {
      elkCalls++;
      elkMs += performance.now() - started;
    }
  };
  const started = performance.now();
  const geometry = await unionGeometry(people, layout, false, [], undefined, previousGeometry);
  const result = {
    seed: thoroughness !== undefined
      ? `thoroughness ${thoroughness}`
      : influence === undefined
        ? selectedSeed ?? "production"
        : `median ${influence}`,
    ...quality(geometry),
    elkCalls,
    elkMs: Math.round(elkMs),
    totalMs: Math.round(performance.now() - started),
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

if (process.env.DREVO_LAYOUT_COMPONENT_SCAN || process.env.DREVO_LAYOUT_ANCESTOR_SCAN) {
  const summary = [];
  const selectedCase = Number(process.env.DREVO_LAYOUT_CASE || 0);
  for (let index = selectedCase || 1; index <= (selectedCase || 24); index++) {
    const original = randomFamily(index);
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
  for (let index = selectedCase || 1; index <= (selectedCase || 24); index++) {
    const original = randomFamily(index);
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
  for (let index = selectedCase || 1; index <= (selectedCase || 24); index++) {
    const people = randomFamily(index);
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
