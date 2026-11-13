import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { branchingFamily, crossBranchMarriages, person, randomFamily } from "./layout-fixtures.ts";
import { preferJointUnionLayout } from "../src/domain/family-layout-candidates.ts";
import { JOINT_UNION_LAYOUT_ID } from "../src/domain/joint-union-order.ts";

const wholeTreeTrial = (graph: ElkNode) =>
  graph.id === JOINT_UNION_LAYOUT_ID;

for (const reverse of [false, true]) test(`joint search improves cross-branch marriages and preserves later local edits (${reverse})`, async () => {
  const people = crossBranchMarriages(21), snapshot = structuredClone(people), elk = new ELK({ algorithms: ["layered"] }), size = treeNodeSize();
  let failures = 0, attempts = 0;
  const baseline = await unionGeometry(people, graph => {
    if (wholeTreeTrial(graph)) { failures++; throw new Error("proposal unavailable"); }
    return elk.layout(graph);
  }, reverse, [], size);
  const improved = await unionGeometry(people, graph => {
    if (wholeTreeTrial(graph)) attempts++;
    return elk.layout(graph);
  }, reverse, [], size);
  assert.equal(failures, 1);
  assert.equal(attempts, 1);
  const scorer = createGeometryContactScorer(size.width, size.height), score = (g: TreeGeometry) => ({
    ...scorer.quality(g), cardHits: scorer.cardContacts(g), overlaps: scorer.cardOverlaps(g),
  });
  assert.ok(score(improved).crossings <= score(baseline).crossings * 0.8);
  assert.equal(score(baseline).crossings, 10, "legacy model-order placements remain enabled in the baseline");
  assert.equal(score(improved).crossings, 8);
  assert.ok(preferJointUnionLayout(improved, baseline, size, score));
  assert.equal(score(improved).cardHits, 0);
  assert.equal(score(improved).overlaps, 0);
  const relations = (g: TreeGeometry) => new Set(g.branches!.flatMap(b => b.relations.map(r =>
    JSON.stringify(r.type === "spouse" ? [r.type, ...[r.from, r.to].sort()] : [r.type, r.from, r.to]))));
  assert.deepEqual(relations(improved), relations(baseline));
  assert.equal(improved.positions.length, people.length);
  assert.deepEqual(people, snapshot);
  const edited = [...people, person("new-descendant", ["last-0"])];
  await unionGeometry(edited, graph => {
    assert.equal(wholeTreeTrial(graph), false, "global search must not reshuffle an incremental edit");
    return elk.layout(graph);
  }, reverse, [], size, improved);
});

test("a large clear scene keeps every person without extra global trials", async () => {
  const people = branchingFamily(1001);
  const elk = new ELK({ algorithms: ["layered"] });
  let calls = 0;
  const geometry = await unionGeometry(
    people,
    (graph) => {
      calls++;
      return elk.layout(graph);
    },
    false,
    [],
    treeNodeSize(),
  );
  assert.equal(calls, 1);
  assert.equal(geometry.positions.length, people.length);
  assert.deepEqual(
    new Set(geometry.occurrences!.map((o) => o.personId)),
    new Set(people.map((p) => p.id)),
  );
});

for (const reverse of [false, true]) test(`declining a joint proposal preserves legacy model-order placement (${reverse})`, async () => {
  const people = crossBranchMarriages(8), size = treeNodeSize();
  const elk = new ELK({ algorithms: ["layered"] });
  let legacyOrdered = 0, proposals = 0;
  const baseline = await unionGeometry(people, graph => {
    if (wholeTreeTrial(graph)) throw new Error("joint proposal unavailable");
    if (graph.layoutOptions?.["elk.layered.crossingMinimization.forceNodeModelOrder"] === "true") legacyOrdered++;
    return elk.layout(graph);
  }, reverse, [], size);
  const result = await unionGeometry(people, graph => {
    if (wholeTreeTrial(graph)) proposals++;
    return elk.layout(graph);
  }, reverse, [], size);
  assert.ok(legacyOrdered > 0, "the baseline retains the existing model-order optimization");
  assert.equal(proposals, 1, "a real joint proposal is evaluated");
  assert.equal(createGeometryContactScorer(size.width, size.height).quality(baseline).crossings, 7);
  assert.deepEqual(result, baseline, "a declined proposal cannot change the incumbent geometry");
});

test("joint search cannot bypass the complete free-order portfolio", async () => {
  const people = crossBranchMarriages(14);
  for (const partner of people.filter(p => p.id.startsWith("partner-")).slice(0, 8)) {
    let child = partner;
    for (let level = 0; level < 19; level++) {
      const parent = person(`ancestor-${partner.id}-${level}`);
      child.parents.push(parent.id);
      people.push(parent);
      child = parent;
    }
  }
  assert.ok(people.length > 200 && people.length <= 300);
  const elk = new ELK({ algorithms: ["layered"] });
  const calls: ("joint" | "free" | "ordinary")[] = [];
  const geometry = await unionGeometry(people, graph => {
    calls.push(wholeTreeTrial(graph) ? "joint" :
      graph.layoutOptions?.["elk.layered.considerModelOrder.strategy"] === "NONE" ? "free" : "ordinary");
    return elk.layout(graph);
  }, false, [], treeNodeSize());
  const lastFree = calls.lastIndexOf("free");
  assert.ok(lastFree >= 0, "the complete incumbent portfolio runs before acceptance");
  assert.ok(calls.every((kind, index) => kind !== "joint" || index > lastFree));
  assert.equal(geometry.positions.length, people.length);
});

for (const reverse of [false, true]) {
  test(`bounded global search retains a crowded graph when its model exceeds the budget (${reverse})`, async () => {
    const people = randomFamily(1, 7),
      snapshot = structuredClone(people),
      size = treeNodeSize();
    const elk = new ELK({ algorithms: ["layered"] });
    let failures = 0,
      attempts = 0;
    const baseline = await unionGeometry(
      people,
      (graph) => {
        if (wholeTreeTrial(graph)) {
          failures++;
          throw new Error("trial unavailable");
        }
        return elk.layout(graph);
      },
      reverse,
      [],
      size,
    );
    const improved = await unionGeometry(
      people,
      (graph) => {
        if (wholeTreeTrial(graph)) attempts++;
        return elk.layout(graph);
      },
      reverse,
      [],
      size,
    );
    assert.equal(failures, 0);
    assert.equal(attempts, failures);
    const scorer = createGeometryContactScorer(size.width, size.height);
    const score = (geometry: TreeGeometry) => ({
      ...scorer.quality(geometry),
      cardHits: scorer.cardContacts(geometry),
      overlaps: scorer.cardOverlaps(geometry),
    });
    assert.deepEqual(improved, baseline);
    assert.deepEqual(score(improved), score(baseline));
    assert.equal(score(improved).cardHits, 0);
    assert.equal(score(improved).overlaps, 0);
    assert.deepEqual(people, snapshot);
    assert.equal(improved.positions.length, people.length);
    assert.deepEqual(
      new Set(improved.occurrences!.map((o) => o.personId)),
      new Set(people.map((p) => p.id)),
    );
    const relations = (geometry: TreeGeometry) =>
      new Set(
        geometry.branches!.flatMap((b) =>
          b.relations.map((r) =>
            JSON.stringify(
              r.type === "spouse"
                ? [r.type, ...[r.from, r.to].sort()]
                : [r.type, r.from, r.to],
            ),
          ),
        ),
      );
    assert.deepEqual(relations(improved), relations(baseline));
    assert.deepEqual(
      improved.generationBands!.map((b) => [b.level, [...b.members].sort()]),
      baseline.generationBands!.map((b) => [b.level, [...b.members].sort()]),
    );
    assert.ok(
      improved.positions.every(
        ([, p]) => Number.isFinite(p.x) && Number.isFinite(p.y),
      ),
    );
  });
}
