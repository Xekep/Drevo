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
function calculate(worker, mode, reverse = false, data = people) {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("message", resolve);
    worker.postMessage({ people: data, links: [], mode, reverse });
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
      const broad = [{ id: "root", birth: "1900", parents: [], spouses: [] }];
      for (let i = 0; i < 18; i++) {
        broad.push(
          {
            id: `child-${i}`,
            birth: "1930",
            parents: ["root"],
            spouses: [`spouse-${i}`],
          },
          {
            id: `spouse-${i}`,
            birth: "1930",
            parents: [],
            spouses: [`child-${i}`],
          },
        );
        for (let j = 0; j < 3; j++)
          broad.push({
            id: `grand-${i}-${j}`,
            birth: "1960",
            parents: [`child-${i}`, `spouse-${i}`],
            spouses: [],
          });
      }
      const packed = await calculate(worker, "generations", false, broad);
      assert.equal(packed.error, undefined);
      assert.equal(
        new Set(packed.occurrences.map((o) => o.personId)).size,
        broad.length,
      );
      const positions = new Map(packed.positions);
      assert.ok(
        new Set(
          Array.from({ length: 18 }, (_, i) => positions.get(`child-${i}`).y),
        ).size > 1,
      );
    } finally {
      await worker.terminate();
    }
  },
);
