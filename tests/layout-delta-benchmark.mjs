// node --experimental-strip-types tests/layout-delta-benchmark.mjs <reference src/domain>
// The reference may be extracted with git archive; no production archive is read.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { cpus, platform, release } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { localTreeLayout } from "../src/domain/local-tree-layout.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import { randomFamily, person } from "./layout-fixtures.ts";

const referenceDomain = process.argv[2];
assert.ok(referenceDomain, "Pass the original revision's src/domain directory");
const reference = await import(
  pathToFileURL(resolve(referenceDomain, "union-layout.ts")).href
);
const repeats = Number(process.env.DREVO_BENCH_REPEATS || 3);
assert.ok(Number.isInteger(repeats) && repeats > 0 && repeats <= 7);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const sourceHash = (root) =>
  hash(
    readdirSync(root)
      .filter((p) => p.endsWith(".ts"))
      .sort()
      .map((p) => `${p}\n${readFileSync(join(root, p), "utf8")}`)
      .join("\n"),
  );
const median = (values) =>
  [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const size = treeNodeSize(),
  cold = [],
  growth = [];
const implementations = {
  reference: reference.unionGeometry,
  current: unionGeometry,
};
// Warm JS/ELK with a separate small graph; all measured calls still have no
// previous geometry, cache or warm ELK instance. This is not browser startup.
for (const layout of Object.values(implementations)) {
  const elk = new ELK();
  await layout(randomFamily(3, 2), (g) => elk.layout(g), false, [], size);
}
const wide = [
  person("root"),
  ...Array.from({ length: 500 }, (_, i) => person(`child-${i}`, ["root"])),
];
for (const [label, people] of [
  ["dense-500", randomFamily(5, 12).slice(0, 500)],
  ["dense-1000", randomFamily(5, 12).slice(0, 1000)],
  ["dense-3000", randomFamily(5, 12).slice(0, 3000)],
  ["other-seed-1000", randomFamily(9, 12).slice(0, 1000)],
  ["wide-501", wide],
]) {
  const rows = [],
    hashes = {};
  for (let repeat = 0; repeat < repeats; repeat++) {
    const order =
      repeat % 2 ? ["current", "reference"] : ["reference", "current"];
    for (const name of order) {
      const elk = new ELK(),
        started = performance.now();
      const geometry = await implementations[name](
        people,
        (g) => elk.layout(g),
        false,
        [],
        size,
      );
      const ms = performance.now() - started;
      const digest = hash(JSON.stringify(geometry));
      hashes[name] ??= digest;
      assert.equal(
        digest,
        hashes[name],
        "Repeated layouts must be deterministic",
      );
      if (hashes.reference && hashes.current)
        assert.equal(
          hashes.reference,
          hashes.current,
          "Cold geometry must remain byte-for-byte identical",
        );
      rows.push({ repeat, implementation: name, ms });
    }
  }
  cold.push({
    label,
    people: people.length,
    inputHash: hash(JSON.stringify(people)),
    geometryHash: hashes.current,
    samples: rows,
    referenceMedianMs: median(
      rows.filter((r) => r.implementation === "reference").map((r) => r.ms),
    ),
    currentMedianMs: median(
      rows.filter((r) => r.implementation === "current").map((r) => r.ms),
    ),
  });
}
for (const generations of [5, 7, 9]) {
  const people = randomFamily(5, generations),
    input = { people, links: [] },
    elk = new ELK();
  const before = await unionGeometry(
    people,
    (g) => elk.layout(g),
    false,
    [],
    size,
  );
  const children = new Set(people.flatMap((p) => p.parents));
  const positions = new Map(before.positions);
  const leaves = people
    .filter((p) => !p.spouses.length && !children.has(p.id))
    .sort((a, b) => positions.get(a.id).x - positions.get(b.id).x);
  const choices = [
    ...new Set([
      leaves[0],
      leaves[Math.floor(leaves.length / 2)],
      leaves.at(-1),
    ]),
  ].filter(Boolean);
  const score = createGeometryContactScorer(size.width, size.height);
  const quality = (g) => ({
    ...score.quality(g),
    hits: score.cardContacts(g),
    overlaps: score.cardOverlaps(g),
  });
  const initial = quality(before),
    attempts = [];
  for (const [index, anchor] of choices.entries()) {
    const spouse = person(`new-partner-${index}`, [], [anchor.id]);
    const edited = {
      people: [
        ...people.map((p) =>
          p.id === anchor.id ? { ...p, spouses: [spouse.id] } : p,
        ),
        spouse,
        person(`new-child-${index}-0`, [anchor.id, spouse.id]),
        person(`new-child-${index}-1`, [anchor.id, spouse.id]),
      ],
      links: [],
    };
    const times = [];
    let result;
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      result = localTreeLayout(edited, input, before, size);
      if (i) times.push(performance.now() - started);
    }
    const row = {
      anchor:
        index === 0
          ? "left-edge"
          : index === choices.length - 1
            ? "right-edge"
            : "middle",
      accepted: !!result,
      medianMs: median(times),
    };
    if (result) {
      assert.deepEqual(
        result.geometry.positions.slice(0, before.positions.length),
        before.positions,
      );
      const next = quality(result.geometry);
      for (const key of ["crossings", "contacts", "hits", "overlaps"])
        assert.ok(next[key] <= initial[key], `Growth must not increase ${key}`);
      row.movedExistingCards = 0;
      row.after = next;
    }
    attempts.push(row);
  }
  growth.push({
    people: people.length,
    inputHash: hash(JSON.stringify(input)),
    before: initial,
    attempts,
  });
}
process.stdout.write(
  JSON.stringify(
    {
      measuredAt: new Date().toISOString(),
      node: process.version,
      os: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      size,
      repeats,
      currentSourceHash: sourceHash(resolve("src/domain")),
      referenceSourceHash: sourceHash(resolve(referenceDomain)),
      method:
        "Alternating reference/current uncached Node geometry after a small JS warmup; new ELK per call. Exact JSON geometry hashes. Growth: left edge/middle/right edge terminal cards, one warmup plus nine trials. Synthetic inputs, not production, browser FPS or peak-memory measurement.",
      cold,
      growth,
    },
    null,
    2,
  ) + "\n",
);
