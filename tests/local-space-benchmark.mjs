// node --experimental-strip-types tests/local-space-benchmark.mjs <reference src/domain>
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import ELK from "elkjs/lib/elk.bundled.js";
import { localTreeLayout } from "../src/domain/local-tree-layout.ts";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import {
  crowdedFamily,
  spaceSize as size,
} from "./local-family-space-fixture.ts";
import { randomFamily, person } from "./layout-fixtures.ts";

assert.ok(process.argv[2], "Pass the original revision's src/domain directory");
const reference = await import(
  pathToFileURL(resolve(process.argv[2], "local-tree-layout.ts")).href
);
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const hash = (value) => createHash("sha256").update(value).digest("hex");
const quality = (g) => {
  const scorer = createGeometryContactScorer(size.width, size.height);
  const { crossings, contacts } = scorer.quality(g);
  return {
    crossings,
    contacts,
    cardHits: scorer.cardContacts(g),
    overlaps: scorer.cardOverlaps(g),
  };
};
function measure(input, next, geometry) {
  const samples = { reference: [], current: [] };
  let result, referenceAccepted;
  for (let trial = 0; trial < 10; trial++) {
    for (const [name, layout] of trial % 2
      ? [
          ["current", localTreeLayout],
          ["reference", reference.localTreeLayout],
        ]
      : [
          ["reference", reference.localTreeLayout],
          ["current", localTreeLayout],
        ]) {
      const start = performance.now();
      const value = layout(next, input, geometry, size);
      if (trial) samples[name].push(performance.now() - start);
      if (name === "current") result = value;
      else referenceAccepted = !!value;
    }
  }
  const before = quality(geometry),
    after = result ? quality(result.geometry) : undefined;
  if (after)
    for (const key of Object.keys(before)) assert.ok(after[key] <= before[key]);
  const old = new Map(geometry.positions);
  const moved = result?.geometry.positions.filter(
    ([id, p]) => old.has(id) && old.get(id).x !== p.x,
  ).length;
  if (result)
    for (const [id, p] of result.geometry.positions)
      if (old.has(id)) assert.equal(p.y, old.get(id).y);
  return {
    referenceMedianMs: median(samples.reference),
    currentMedianMs: median(samples.current),
    samples,
    referenceAccepted,
    accepted: !!result,
    movedExistingCards: moved,
    before,
    after,
  };
}
const rows = [];
for (const count of [205, 977, 3000]) {
  const { input, next, geometry } = crowdedFamily(count);
  const snapshot = JSON.stringify(geometry);
  const entry = measure(input, next, geometry);
  assert.ok(entry.accepted);
  assert.equal(entry.movedExistingCards, 2);
  assert.equal(
    reference.localTreeLayout(next, input, geometry, size),
    undefined,
  );
  const elk = new ELK(),
    start = performance.now();
  await unionGeometry(next.people, (g) => elk.layout(g), false, [], size);
  entry.editedFullSingleMs = performance.now() - start;
  assert.equal(JSON.stringify(geometry), snapshot);
  rows.push({
    case: "controlled-crowded-row",
    count,
    inputHash: hash(JSON.stringify(input)),
    ...entry,
  });
}
// Connected, repeated marriages and multiple generations: not every crowded
// terminal is safe to shift. Report rejected attempts too, not just successes.
const people = randomFamily(5, 9),
  input = { people, links: [] },
  elk = new ELK();
const geometry = await unionGeometry(
  people,
  (g) => elk.layout(g),
  false,
  [],
  size,
);
const parentIds = new Set(people.flatMap((p) => p.parents));
const leaves = people.filter((p) => !p.spouses.length && !parentIds.has(p.id));
for (const index of [0, 0.25, 0.5, 0.75, 1].map((f) =>
  Math.floor(f * (leaves.length - 1)),
)) {
  const anchor = leaves[index];
  const next = {
    people: [
      ...people.map((p) =>
        p.id === anchor.id ? { ...p, spouses: ["new-partner"] } : p,
      ),
      person("new-partner", [], [anchor.id]),
    ],
    links: [],
  };
  rows.push({
    case: "connected-977",
    count: people.length,
    anchorIndex: index,
    ...measure(input, next, geometry),
  });
}
const sources = [
  "../src/domain/local-family-space.ts",
  "../src/domain/local-family-growth.ts",
  "../src/domain/local-tree-layout.ts",
  "./local-family-space-fixture.ts",
  "./local-space-benchmark.mjs",
];
process.stdout.write(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      hardwareThreads: cpus().length,
      size,
      sourceHash: hash(
        sources
          .map((p) => readFileSync(new URL(p, import.meta.url), "utf8"))
          .join("\n"),
      ),
      method:
        "Synthetic Node. Local check: one warmup, nine samples per implementation, alternating order. Full: one sample, fresh ELK, no history. Controlled scenes deliberately have a gap beyond nearby chains; connected fixture uses actual cold ELK geometry. No browser FPS, memory or general acceptance-rate claim. Reference 2368960b.",
      rows,
    },
    null,
    2,
  ) + "\n",
);
