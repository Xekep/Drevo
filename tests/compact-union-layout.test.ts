import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import { randomFamily, editedAncestorFamily } from "./layout-fixtures.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

const size = treeNodeSize();
const scorer = createGeometryContactScorer(size.width, size.height);
const width = (g: TreeGeometry) => {
  const xs = g.positions.map(([, p]) => p.x);
  return Math.max(...xs) - Math.min(...xs) + size.width;
};
const bands = (g: TreeGeometry) =>
  g.generationBands!.map((band) => [band.level, [...band.members].sort()]);
const relations = (g: TreeGeometry) =>
  g
    .branches!.flatMap((branch) =>
      branch.relations.map((relation) => JSON.stringify(relation)),
    )
    .sort();

test("compact placement removes horizontal space without degrading family routes in either direction", async () => {
  const people = randomFamily(4, 4),
    original = structuredClone(people);
  const engine = new ELK({ algorithms: ["layered"] });
  for (const reverse of [false, true]) {
    let compactCalls = 0;
    const baseline = await unionGeometry(
      people,
      (graph) => {
        if (
          graph.layoutOptions?.["elk.layered.nodePlacement.strategy"] ===
          "NETWORK_SIMPLEX"
        )
          throw new Error("omit optional compact placement");
        return engine.layout(graph);
      },
      reverse,
      [],
      size,
    );
    const improved = await unionGeometry(
      people,
      (graph) => {
        if (
          graph.layoutOptions?.["elk.layered.nodePlacement.strategy"] ===
          "NETWORK_SIMPLEX"
        )
          compactCalls++;
        return engine.layout(graph);
      },
      reverse,
      [],
      size,
    );
    assert.equal(compactCalls, 1);
    assert.ok(width(improved) <= width(baseline) * 0.95);
    const before = scorer.quality(baseline),
      after = scorer.quality(improved);
    for (const key of ["contacts", "crossings", "length", "bends"] as const)
      assert.ok(after[key] <= before[key], key);
    assert.equal(scorer.cardContacts(improved), 0);
    assert.equal(scorer.cardOverlaps(improved), 0);
    assert.deepEqual(bands(improved), bands(baseline));
    assert.deepEqual(relations(improved), relations(baseline));
    assert.deepEqual(improved.occurrences, baseline.occurrences);

    let incrementalCompactCalls = 0;
    const edited = editedAncestorFamily(people, 4);
    const incremental = await unionGeometry(
      edited,
      (graph) => {
        if (
          graph.layoutOptions?.["elk.layered.nodePlacement.strategy"] ===
          "NETWORK_SIMPLEX"
        )
          incrementalCompactCalls++;
        return engine.layout(graph);
      },
      reverse,
      [],
      size,
      improved,
    );
    assert.equal(
      incrementalCompactCalls,
      0,
      "edits keep the existing incremental solver",
    );
    assert.equal(
      new Set(incremental.occurrences!.map((p) => p.personId)).size,
      edited.length,
    );
    assert.equal(scorer.cardContacts(incremental), 0);
    assert.equal(scorer.cardOverlaps(incremental), 0);
  }
  assert.deepEqual(people, original);
});

test("a compact solver that worsens the routes leaves the established layout intact", async () => {
  const people = randomFamily(1, 4);
  const engine = new ELK({ algorithms: ["layered"] });
  const baseline = await unionGeometry(
    people,
    (graph) => {
      if (
        graph.layoutOptions?.["elk.layered.nodePlacement.strategy"] ===
        "NETWORK_SIMPLEX"
      )
        throw new Error("omit optional compact placement");
      return engine.layout(graph);
    },
    false,
    [],
    size,
  );
  let attempts = 0;
  const result = await unionGeometry(
    people,
    (graph) => {
      if (
        graph.layoutOptions?.["elk.layered.nodePlacement.strategy"] ===
        "NETWORK_SIMPLEX"
      )
        attempts++;
      return engine.layout(graph);
    },
    false,
    [],
    size,
  );
  assert.equal(attempts, 1);
  assert.deepEqual(result, baseline);
});
