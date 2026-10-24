// node --experimental-strip-types tests/local-layout-benchmark.mjs > results.json
// Synthetic Node timings; not browser FPS, peak memory, or production latency.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import ELK from "elkjs/lib/elk.bundled.js";
import { localTreeLayout } from "../src/domain/local-tree-layout.ts";
import { unionGeometry, createGeometryContactScorer } from "../src/domain/union-layout.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import { randomFamily, person } from "./layout-fixtures.ts";

const hash = value => createHash("sha256").update(value).digest("hex");
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const size = treeNodeSize(), scorer = createGeometryContactScorer(size.width, size.height);
const quality = geometry => {
  const { crossings, contacts, length } = scorer.quality(geometry);
  return { crossings, contacts, length, cardOverlaps: scorer.cardOverlaps(geometry), cardContacts: scorer.cardContacts(geometry) };
};
const rows = [];
for (const count of [500, 1000, 3000]) {
  const people = randomFamily(5, 12).slice(0, count), input = { people, links: [] }, elk = new ELK();
  let started = performance.now();
  const geometry = await unionGeometry(people, g => elk.layout(g), false, [], size);
  const coldMs = performance.now() - started, before = quality(geometry);
  const parents = [...new Map(people.filter(p => p.parents.length === 2).map(p => [JSON.stringify(p.parents), p.parents])).values()];
  const choices = parents.filter((_, i) => i % Math.max(1, Math.floor(parents.length / 10)) === 0).slice(0, 10);
  const samples = [];
  let firstSafe;
  for (const [index, pair] of choices.entries()) {
    const edited = { people: [...people, person(`new-leaf-${index}`, pair)], links: [] };
    const timings = [];
    let result;
    for (let trial = 0; trial < 10; trial++) {
      started = performance.now();
      result = localTreeLayout(edited, input, geometry, size);
      const elapsed = performance.now() - started;
      if (trial) timings.push(elapsed);
    }
    const entry = { index, accepted: !!result, medianMs: median(timings) };
    if (result) {
      entry.after = quality(result.geometry);
      entry.movedExistingCards = result.geometry.positions.filter(([id, p]) => {
        const old = new Map(geometry.positions).get(id);
        return old && (old.x !== p.x || old.y !== p.y);
      }).length;
      assert.equal(entry.movedExistingCards, 0);
      for (const metric of ["crossings", "contacts", "cardOverlaps", "cardContacts"]) assert.ok(entry.after[metric] <= before[metric]);
      firstSafe ||= edited;
    }
    samples.push(entry);
  }
  const dated = { ...input, people: people.map(p => ({ ...p, birth: "1900" })) }, dateTimes = [];
  for (let trial = 0; trial < 10; trial++) {
    started = performance.now();
    assert.equal(localTreeLayout(dated, input, geometry, size)?.geometry, geometry);
    if (trial) dateTimes.push(performance.now() - started);
  }
  let editedColdMs;
  if (firstSafe) {
    started = performance.now();
    await unionGeometry(firstSafe.people, g => elk.layout(g), false, [], size);
    editedColdMs = performance.now() - started;
  }
  rows.push({ count, inputHash: hash(JSON.stringify(input)), coldMs, editedColdMs,
    dateOnlyMedianMs: median(dateTimes), before, accepted: samples.filter(s => s.accepted).length, attempted: samples.length, samples });
}
const sources = ["../src/domain/local-tree-layout.ts", "../src/domain/tree-layout-constants.ts", "../src/domain/union-layout.ts",
  "../src/domain/household-levels.ts", "../src/domain/union-groups.ts", "../src/domain/edge-routing.ts", "./layout-fixtures.ts"];
process.stdout.write(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model, hardwareThreads: cpus().length, size, sourceHash: hash(sources.map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n")),
  method: "Cold layout: one sample per case. Local/date: one warmup, nine samples, median. Rejected local checks precede a full layout. Synthetic seed 5, twelve generations truncated in model order. No browser or memory claim.", rows }, null, 2) + "\n");
