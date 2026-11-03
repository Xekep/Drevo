import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import { sharedTreeLayoutCache } from "../src/server/tree-layout-cache.ts";
import { treeLayoutCalculator } from "../src/server/tree-layout-calculator.ts";
import {
  layoutCacheKey,
  type LayoutCacheInput,
} from "../src/domain/layout-cache-key.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { person } from "./layout-fixtures.ts";

const input: LayoutCacheInput = {
  people: [person("parent"), person("child", ["parent"])],
  links: [],
  mode: "generations",
  reverse: false,
};
const hash = createHash("sha256").update(layoutCacheKey(input)).digest("hex");
const geometry: TreeGeometry = {
  mode: "generations",
  reverse: false,
  start: 1700,
  offset: 0,
  positions: [
    ["parent", { x: 0, y: 0 }],
    ["child", { x: 0, y: 500 }],
  ],
};
async function waitFor(check: () => Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail("cache did not finish warming");
}

test("shared layout survives restart, deduplicates concurrent runtimes and repairs corrupt entries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "drevo-layout-"));
  let calculations = 0;
  const calculator = {
    calculate: async () => {
      calculations++;
      await delay(40);
      return geometry;
    },
  };
  const a = sharedTreeLayoutCache(root, calculator),
    b = sharedTreeLayoutCache(root, calculator);
  t.after(async () => {
    await a.close();
    await b.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.deepEqual(
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? a : b).readOrWarm(hash, input),
      ),
    ),
    Array(12).fill(null),
  );
  await waitFor(async () => !!(await b.readOrWarm(hash, input)));
  assert.equal(calculations, 1);
  await a.close();
  await b.close();
  const c = sharedTreeLayoutCache(root, calculator);
  try {
    assert.deepEqual(await c.readOrWarm(hash, input), geometry);
    assert.equal(calculations, 1);
    const path = join(root, ".tree-layout-cache", `${hash}.json`);
    const entry = JSON.parse(await readFile(path, "utf8"));
    entry.value = JSON.stringify({ ...geometry, positions: [] });
    await writeFile(path, JSON.stringify(entry));
    assert.equal(await c.readOrWarm(hash, input), null);
    await waitFor(async () => !!(await c.readOrWarm(hash, input)));
    assert.deepEqual(await c.readOrWarm(hash, input), geometry);
    assert.equal(calculations, 2);
    assert.equal(await c.readOrWarm("../invalid", input), null);
  } finally {
    await c.close();
  }
});

test("failed warm can retry, changed layout uses another entry, closing aborts owned work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "drevo-layout-"));
  let calls = 0,
    stopped = false;
  const cache = sharedTreeLayoutCache(root, {
    calculate: async (request, signal) => {
      calls++;
      if (calls === 1) throw new Error("temporary failure");
      if (request.reverse) {
        try {
          await delay(60_000, undefined, { signal });
        } catch {
          stopped = signal.aborted;
          throw signal.reason;
        }
      }
      return geometry;
    },
  });
  t.after(async () => {
    await cache.close();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(await cache.readOrWarm(hash, input), null);
  await waitFor(async () => !!(await cache.readOrWarm(hash, input)));
  assert.equal(calls, 2);
  const reversed = { ...input, reverse: true };
  const nextHash = createHash("sha256")
    .update(layoutCacheKey(reversed))
    .digest("hex");
  assert.equal(await cache.readOrWarm(nextHash, reversed), null);
  await waitFor(async () => calls === 3);
  await cache.close();
  assert.equal(stopped, true);
});

test("server layout Worker computes portrait geometry and cancels queued work", async () => {
  const calculator = treeLayoutCalculator();
  try {
    const result = await calculator.calculate(
      input,
      new AbortController().signal,
    );
    assert.equal(result.positions.length, 2);
    assert.deepEqual(result.nodeSize, { width: 220, height: 264 });
    assert.ok(result.branches?.some((branch) => branch.target === "child"));
    const stop = new AbortController();
    stop.abort();
    await assert.rejects(calculator.calculate(input, stop.signal));
  } finally {
    await calculator.close();
  }
});
