import test from "node:test";
import assert from "node:assert/strict";
import childProcess, { type SpawnOptions } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../src/server/index.ts";

for (const stage of ["snapshot", "tar"] as const) {
  test(`raw backup disconnect stops ${stage}, releases shared admission and removes staging`, { timeout: 30_000 }, async t => {
    t.mock.method(console, "error", () => {});
    const directory = await mkdtemp(join(tmpdir(), "drevo-raw-backup-"));
    const app = await startServer(0, join(directory, "archive.sqlite"), true);
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const spawned = Promise.withResolvers<void>();
    const exited = Promise.withResolvers<void>();
    const controller = new AbortController();
    const originalSpawn = childProcess.spawn;
    let staging = "", active = 0, starts = 0;
    t.mock.method(childProcess, "spawn", ((command: string, args: string[], options: SpawnOptions) => {
      const matches = stage === "tar" ? command === "tar"
        : args.some(arg => arg.endsWith("backup-worker.mjs"));
      if (!matches) return originalSpawn(command, args, options);
      starts++;
      active++;
      staging = stage === "tar" ? dirname(args[2]) : dirname(args[3]);
      // Keep a real child alive until the route's AbortSignal kills it.
      const child = originalSpawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], options);
      child.once("spawn", () => spawned.resolve());
      child.once("exit", () => { active--; exited.resolve(); });
      return child;
    }) as typeof childProcess.spawn);
    syncBuiltinESMExports();
    const pending = fetch(base + "/api/backup/full", { signal: controller.signal }).catch(error => error);
    try {
      await spawned.promise;
      const busy = await fetch(base + "/api/backup");
      assert.equal(busy.status, 409);
      assert.equal(busy.headers.get("retry-after"), "2");
      await busy.arrayBuffer();
      const managed = await fetch(base + "/api/backups/create", { method: "POST",
        headers: { "x-drevo-backup": "1", "Content-Type": "application/json" }, body: "{}" });
      assert.equal(managed.status, 409, "managed creation cannot bypass the raw download lease");
      await managed.arrayBuffer();
      assert.equal(starts, 1);
      controller.abort();
      assert.equal((await pending).name, "AbortError");
      await exited.promise;
      for (let attempt = 0; ; attempt++) {
        const status = await fetch(base + "/api/backups").then(response => response.json());
        if (status.job?.state === "failed") break;
        assert.ok(attempt < 100, "cancelled work should finish cleanup and release its lease");
        await delay(20);
      }
      assert.equal(active, 0);
      await assert.rejects(access(staging), { code: "ENOENT" });
      t.mock.restoreAll();
      syncBuiltinESMExports();
      const retry = await fetch(base + "/api/backup");
      assert.equal(retry.status, 200);
      const bytes = Buffer.from(await retry.arrayBuffer());
      assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
    } finally {
      controller.abort();
      await pending;
      await app.close();
      t.mock.restoreAll();
      syncBuiltinESMExports();
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("raw full download completes normally and releases its lease for the next request", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-raw-complete-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    for (const path of ["/api/backup/full", "/api/backup"]) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(bytes.length, Number(response.headers.get("content-length")));
      if (path.endsWith("full")) assert.deepEqual([...bytes.subarray(0, 2)], [31, 139]);
      else assert.equal(bytes.subarray(0, 16).toString(), "SQLite format 3\0");
      const status = await fetch(base + "/api/backups").then(response => response.json());
      assert.equal(status.job?.state, "succeeded");
      assert.equal(status.job?.kind, "download");
      assert.equal(status.total, 0);
    }
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
