import test from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
const dist = fileURLToPath(new URL("../dist/", import.meta.url));
const bundle = readdirSync(join(dist, "assets")).find(
  (p) => p.startsWith("layout.worker-") && p.endsWith(".js"),
);
assert.ok(bundle, "Сначала выполните npm run build");
const people = [
  { id: "a", birth: "1900", parents: [], spouses: ["b", "c"] },
  { id: "b", birth: "", parents: [], spouses: ["a"] },
  { id: "c", birth: "", parents: [], spouses: ["a"] },
  { id: "ab", birth: "1930", parents: ["a", "b"], spouses: [] },
  { id: "ac", birth: "1935", parents: ["a", "c"], spouses: [] },
];
function calculate(worker, mode, reverse = false) {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", resolve);
    worker.postMessage({ people, links: [], mode, reverse });
  });
}
test(
  "production worker executes nested ELK and switches back to timeline",
  { timeout: 20000 },
  async () => {
    const worker = new Worker(
      new URL("./helpers/worker-runtime.mjs", import.meta.url),
      {
        workerData: {
          url: pathToFileURL(join(dist, "assets", bundle)).href,
          dist,
        },
      },
    );
    try {
      const g = await calculate(worker, "generations");
      assert.equal(g.error, undefined);
      assert.equal(g.blocks.length, 2);
      assert.equal(g.occurrences.length, 6);
      assert.equal(g.branches.length, 4);
      const timeline = await calculate(worker, "timeline");
      assert.equal(timeline.error, undefined);
      assert.equal(timeline.positions.length, g.positions.length);
      assert.equal(timeline.branches.length, g.branches.length);
      assert.equal(timeline.coveredRelations.length, 6);
      const reverse = await calculate(worker, "generations", true);
      assert.equal(reverse.error, undefined);
      assert.equal(reverse.reverse, true);
      assert.equal(reverse.branches.length, g.branches.length);
    } finally {
      await worker.terminate();
    }
  },
);
