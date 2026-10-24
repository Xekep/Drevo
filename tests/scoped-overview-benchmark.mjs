// node --experimental-strip-types tests/scoped-overview-benchmark.mjs > results.json
// Local SQLite isolates projection/JSON/cache cost, not PostgreSQL throughput.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { cpus, platform } from "node:os";
import { openArchive } from "../src/server/database.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import { archiveOverview } from "../src/domain/archive-projection.ts";
import { person } from "./layout-fixtures.ts";

const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const hash = text => createHash("sha256").update(text).digest("hex"), results = [];
for (const count of [1000, 10000]) for (const fraction of [0.01, 0.9]) {
  const data = { title: "Synthetic", description: "", demo: false, people: Array.from({ length: count }, (_, i) => ({
    ...person(i ? `p-${i}` : "root", i > 0 && i < Math.ceil(count * fraction) ? ["root"] : []),
    name: "Name", surname: "Test", patronymic: "", sex: "u", birthPlace: "", generation: 1, column: 0,
    sources: [], biography: "x".repeat(200),
  })), photos: [] };
  const store = await openArchive(":memory:", data);
  try {
    const user = { id: "reader", name: "Reader", approved: true, role: "reader", createdAt: "", personId: "root", treeAccess: "common_ancestors" };
    const old = async () => {
      const overview = await store.overview(), family = archiveOverview(projectFamilyForUser(overview.family, user));
      return { family, revision: overview.revision, totals: { people: family.people.length,
        photos: await store.photoCount({ visible: new Set(family.people.map(p => p.id)), userId: user.id }) } };
    };
    const baseline = await old(), start = performance.now(), first = await store.scopedOverview(user);
    const firstNewMs = performance.now() - start;
    assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(baseline)));
    const oldTimes = [], newTimes = [];
    for (let i = 0; i < 16; i++) {
      let t = performance.now(); await old(); const oldMs = performance.now() - t;
      t = performance.now(); await store.scopedOverview(user); const newMs = performance.now() - t;
      if (i) { oldTimes.push(oldMs); newTimes.push(newMs); }
    }
    results.push({ count, fraction, visible: baseline.family.people.length, inputHash: hash(JSON.stringify(data)), firstNewMs,
      oldMedianMs: median(oldTimes), newMedianMs: median(newTimes), oldTimes, newTimes, cacheAccounting: store.cacheBudget.diagnostics() });
  } finally { await store.close(); }
}
const sources = ["../src/server/database.ts", "../src/server/archive-read-cache.ts", "../src/server/archive-visibility-cache.ts",
  "../src/domain/tree-access.ts", "../src/domain/family-neighborhood.ts"];
process.stdout.write(JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version, os: platform(), cpu: cpus()[0]?.model,
  sourceHash: hash(sources.map(path => readFileSync(new URL(path, import.meta.url), "utf8")).join("\n")),
  method: "Synthetic in-memory SQLite. Both paths return equal JSON. Alternating old/new warm reads; one warmup then median of 15 samples. First new call follows a warmed old overview, not a cold process. Shared byte accounting is not peak RSS. No PostgreSQL/network/FPS/load-test claim.", results }, null, 2) + "\n");
