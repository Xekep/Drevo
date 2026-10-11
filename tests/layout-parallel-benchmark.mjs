// Run separately from build/tests: node --experimental-strip-types tests/layout-parallel-benchmark.mjs
import { Worker } from "node:worker_threads";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { randomFamily } from "./layout-fixtures.ts";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const bundle = readdirSync(join(dist, "assets")).find((name) => /^layout\.worker-.*\.js$/.test(name));
assert.ok(bundle, "Build first");
const people = randomFamily(5, 9);
let expected;
for (let repeat = 0; repeat < 3; repeat++) for (const parallelCandidates of (repeat % 2 ? [true, false] : [false, true])) {
  const worker = new Worker(new URL("./helpers/worker-runtime.mjs", import.meta.url), {
    workerData: { url: pathToFileURL(join(dist, "assets", bundle)).href, dist },
  });
  try {
    const started = performance.now();
    const response = new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
    worker.postMessage({ people, links: [], mode: "generations", reverse: false, parallelCandidates });
    const geometry = await response;
    const ms = performance.now() - started;
    assert.equal(geometry.error, undefined);
    const sha256 = createHash("sha256").update(JSON.stringify(geometry)).digest("hex");
    expected ??= sha256; assert.equal(sha256, expected);
    process.stdout.write(JSON.stringify({ repeat, people: people.length, workers: parallelCandidates ? 2 : 1, ms, sha256 }) + "\n");
  } finally { await worker.terminate(); }
}
