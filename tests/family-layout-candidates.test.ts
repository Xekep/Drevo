import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { randomFamily } from "./layout-fixtures.ts";
import { preferFamilyLayout } from "../src/domain/family-layout-candidates.ts";
import { translateFamilyBlocks } from "../src/domain/family-row-moves.ts";

const size = { width: 220, height: 264 };
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
    assert.ok(calls <= 11);
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
  assert.equal(failed, 2);
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
