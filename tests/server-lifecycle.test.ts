import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";

test("failed listen releases startup timers and permits a subsequent idempotent shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-startup-lifecycle-"));
  const occupied = createServer();
  await new Promise<void>((done) => occupied.listen(0, "127.0.0.1", done));
  const intervals = new Set<ReturnType<typeof setInterval>>();
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  globalThis.setInterval = ((...args: Parameters<typeof setInterval>) => {
    const interval = originalSet(...args);
    intervals.add(interval);
    return interval;
  }) as typeof setInterval;
  globalThis.clearInterval = (interval) => {
    intervals.delete(interval as ReturnType<typeof setInterval>);
    originalClear(interval);
  };
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    const path = join(directory, "archive.sqlite");
    await assert.rejects(
      startServer((occupied.address() as { port: number }).port, path, true),
      (error: NodeJS.ErrnoException) => error.code === "EADDRINUSE",
    );
    assert.equal(
      intervals.size,
      0,
      "a failed startup must release every created timer",
    );
    app = await startServer(0, path, true);
    await Promise.all([app.close(), app.close()]);
    assert.equal(intervals.size, 0);
    assert.equal(app.server.listening, false);
  } finally {
    await app?.close();
    for (const interval of intervals) originalClear(interval);
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    await new Promise<void>((done) => occupied.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});
