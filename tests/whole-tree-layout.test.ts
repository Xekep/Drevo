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

const wholeTreeTrial = (graph: ElkNode) =>
  graph.layoutOptions?.["elk.layered.crossingMinimization.forceNodeModelOrder"] === "true";

for (const reverse of [false, true]) test(`joint search improves cross-branch marriages and preserves later local edits (${reverse})`, async () => {
  const people = crossBranchMarriages(7), snapshot = structuredClone(people), elk = new ELK({ algorithms: ["layered"] }), size = treeNodeSize();
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
