import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { randomFamily } from "./layout-fixtures.ts";
import { preferColdFamilyLayout, preferFamilyLayout } from "../src/domain/family-layout-candidates.ts";
import { translateFamilyBlocks } from "../src/domain/family-row-moves.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { familyAxisQuality } from "../src/domain/family-axis.ts";

const size = { width: 220, height: 264 };

test("cold comparison can untangle sibling groups without relaxing local edit rules", () => {
  const make = (untangled: boolean): TreeGeometry => {
    const xs: Record<string, number> = {
      p: untangled ? 150 : 0, q: untangled ? 1250 : 900, r: -1000,
      a: 0, b: untangled ? 300 : 600, c: untangled ? 600 : 300, d: -500, e: 1000,
    };
    const parents = ["p", "q", "r"], children = ["a", "b", "c", "d", "e"];
    const pairs = [["p", "a"], ["p", "b"], ["q", "c"], ["r", "d"], ["r", "e"]];
    return {
      mode: "generations", reverse: false, start: 1700, offset: 0,
      positions: Object.entries(xs).map(([id, x]) => [id, { x, y: parents.includes(id) ? 0 : 600 }]),
      occurrences: Object.keys(xs).map(id => ({ id, personId: id, block: id })),
      generationBands: [parents, children].map((members, level) => ({ level,
        targetY: level * 600, minY: level * 600, maxY: level * 600, members })),
      branches: pairs.map(([source, target]) => {
        const y = 350 + parents.indexOf(source) * 50;
        return { id: `child:${source}:${target}`, source, target, union: source,
          relations: [{ from: source, to: target, type: "parent" }],
          route: { sourceHandle: "bottom", targetHandle: "top", points: [
            { x: xs[source] + 110, y: 264 }, { x: xs[source] + 110, y },
            { x: xs[target] + 110, y }, { x: xs[target] + 110, y: 600 },
          ] } };
      }),
    };
  };
  const before = make(false), after = make(true);
  const scorer = createGeometryContactScorer(size.width, size.height);
  const score = (geometry: TreeGeometry) => ({ ...scorer.quality(geometry),
    cardHits: scorer.cardContacts(geometry), overlaps: scorer.cardOverlaps(geometry) });
  assert.ok(familyAxisQuality(after, size).single > familyAxisQuality(before, size).single);
  assert.ok(score(after).crossings < score(before).crossings);
  assert.equal(preferFamilyLayout(after, before, size, score), false);
  assert.equal(preferColdFamilyLayout(after, before, size, score), true);
  for (const unsafe of ["cardHits", "overlaps", "crossings", "contacts"] as const) {
    const worsened = (g: TreeGeometry) => g === after ? { ...score(g), [unsafe]: score(before)[unsafe] + 1 } : score(g);
    assert.equal(preferColdFamilyLayout(after, before, size, worsened), false, unsafe);
  }
});
for (const reverse of [false, true])
  test(`free-order alternatives cannot discard the productive original candidate (${reverse})`, async () => {
    const people = randomFamily(6, 5),
      elk = new ELK();
    let calls = 0;
    const geometry = await unionGeometry(
      people,
      (graph) => {
        calls++;
        return elk.layout(graph);
      },
      reverse,
      [],
      size,
    );
    const scorer = createGeometryContactScorer(220, 264),
      quality = scorer.quality(geometry);
    // Replacing the existing NS probes produced 342 crossings / 344 contacts.
    // Retaining them first preserves the established ceiling of 335 / 337.
    assert.ok(quality.crossings <= 335);
    assert.ok(quality.contacts <= 337);
    assert.ok(calls <= 15);
    assert.equal(scorer.cardContacts(geometry), 0);
    assert.equal(scorer.cardOverlaps(geometry), 0);
    assert.equal(geometry.positions.length, people.length);
    assert.deepEqual(
      new Set(geometry.occurrences!.map((o) => o.personId)),
      new Set(people.map((p) => p.id)),
    );
  });

test("a failed independent solver retains a complete accepted scene", async () => {
  const people = randomFamily(4, 5),
    elk = new ELK();
  let failed = 0;
  const geometry = await unionGeometry(
    people,
    (graph) => {
      if (
        graph.layoutOptions?.["elk.layered.considerModelOrder.strategy"] ===
        "NONE"
      ) {
        failed++;
        return Promise.reject(new Error("independent solver unavailable"));
      }
      return elk.layout(graph);
    },
    false,
    [],
    size,
  );
  assert.equal(failed, 6);
  assert.equal(geometry.positions.length, people.length);
  assert.ok(
    createGeometryContactScorer(220, 264).quality(geometry).crossings <= 199,
  );
});

test("a family cannot trade its vertical axis for an arbitrary new position", async () => {
  const elk = new ELK(),
    people = [
      { id: "a", birth: "", parents: [], spouses: [] },
      { id: "b", birth: "", parents: ["a"], spouses: [] },
      { id: "c", birth: "", parents: ["b"], spouses: [] },
    ];
  const current = await unionGeometry(
    people,
    (graph) => elk.layout(graph),
    false,
    [],
    size,
  );
  const block = current.occurrences!.find((o) => o.personId === "b")!.block;
  const moved = translateFamilyBlocks(
    current,
    new Map([[block, 800]]),
  ).geometry;
  const scorer = createGeometryContactScorer(220, 264);
  const score = (g: typeof current) => ({
    ...scorer.quality(g),
    cardHits: scorer.cardContacts(g),
    overlaps: scorer.cardOverlaps(g),
  });
  assert.equal(preferFamilyLayout(moved, current, size, score), false);
  assert.equal(preferFamilyLayout(current, current, size, score), false);
});
