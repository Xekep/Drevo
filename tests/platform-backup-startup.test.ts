import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../src/server/database.ts";
import { platformBackupCoordinator } from "../src/server/platform-backup-coordinator.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";

test("backend startup reads an existing catalog while the CLI backup owns the global lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-backup-startup-"));
  const path = join(directory, "drevo.sqlite");
  const archive = await openArchive(path, { title: "Тест", description: "", demo: false,
    people: [], photos: [], links: [] });
  let lockedByCopy = false, lockCalls = 0;
  const db: StoreDatabase = { ...archive.db, async withExclusivePlatformTask(_task, work) {
    lockCalls++;
    if (lockedByCopy) throw new Error("A running CLI copy owns the platform lock");
    return work();
  } };
  try {
    const first = await platformBackupCoordinator(db, path, { schedule: false });
    await first.close();
    assert.equal(lockCalls, 1, "initial catalog creation requires a lock");
    const catalog = join(directory, "platform-backups", "catalog.json");
    const state = JSON.parse(await readFile(catalog, "utf8"));
    state.job = { id: "cli-copy", kind: "create", state: "running", startedAt: new Date().toISOString() };
    state.lease = Date.now() + 60_000;
    await writeFile(catalog, JSON.stringify(state), { mode: 0o600 });
    lockedByCopy = true;
    const second = await platformBackupCoordinator(db, path, { schedule: false });
    try {
      assert.equal((await second.status()).job?.state, "running");
      assert.equal(lockCalls, 1, "backend startup must not compete with the running dump");
      assert.deepEqual(JSON.parse(await readFile(catalog, "utf8")), state,
        "startup preserves the active CLI lease and catalog");
    } finally { await second.close(); }
  } finally {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});
