import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { openArchive } from "../src/server/database.ts";
import { backupCoordinator } from "../src/server/backup-coordinator.ts";
import { platformBackupCoordinator } from "../src/server/platform-backup-coordinator.ts";
import { canManageTreeBackups, type ArchiveUser } from "../src/domain/access.ts";
import { assertPlatformBackupRole } from "../src/server/platform-backup-snapshot.ts";
import { lockBackupStaff } from "../src/server/tree-backup-access.ts";
import type pg from "pg";

const owner: ArchiveUser = { id: "local", name: "Владелец", role: "admin",
  approved: true, createdAt: "" };
const seed = { title: "Синтетическое древо", description: "", demo: false, people: [],
  photos: [{ id: "photo", title: "Оригинал", url: "/media/11111111-1111-4111-8111-111111111111.png", tags: [] }], links: [] };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "drevo-boundaries-")), path = join(root, "drevo.sqlite");
  await mkdir(join(root, "uploads"));
  await writeFile(join(root, "uploads", "11111111-1111-4111-8111-111111111111.png"), Buffer.from("original"));
  await writeFile(join(root, "uploads", "unreferenced.pdf"), "foreign or abandoned original");
  await writeFile(path + ".secrets.key", Buffer.alloc(32, 7), { mode: 0o600 });
  await mkdir(join(root, "archives", "other", "uploads"), { recursive: true });
  await writeFile(join(root, "archives", "other", "uploads", "foreign.pdf"), "other archive");
  const archive = await openArchive(path, seed);
  return { root, path, archive, close: async () => { await archive.close(); await rm(root, { recursive: true, force: true }); } };
}

test("tree backup requires approved ownership and an actual global staff grant", () => {
  assert.equal(canManageTreeBackups(owner), true);
  for (const globalRole of ["admin", "researcher", null] as const)
    for (const archiveOwner of [true, false])
      for (const approved of [true, false])
        assert.equal(canManageTreeBackups({ ...owner, treeRole: "relative", globalRole, archiveOwner, approved }),
          archiveOwner && approved && globalRole !== null);
  assert.equal(canManageTreeBackups({ ...owner, treeRole: "relative", archiveOwner: true }), false);
  assert.equal(canManageTreeBackups({ ...owner, role: "reader" }), false);
});

test("native full backup rejects scoped non-BYPASSRLS roles", () => {
  assert.throws(() => assertPlatformBackupRole({ rolsuper: false, rolbypassrls: false }));
  assert.doesNotThrow(() => assertPlatformBackupRole({ rolsuper: false, rolbypassrls: true }));
});

test("researcher authorization locks the real grant after checking admin", async () => {
  const calls: string[] = [];
  const client = { query: async (sql: string) => {
    calls.push(sql); return { rowCount: sql.includes("platform_researchers") ? 1 : 0 };
  } } as unknown as pg.PoolClient;
  assert.equal(await lockBackupStaff(client, "synthetic"), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((sql) => sql.includes("FOR SHARE NOWAIT")));
});

test("manual tree copies pin only selected originals, scrub credentials, never schedule and retain five", async () => {
  const f = await fixture();
  const backups = await backupCoordinator(f.archive.db, f.path, { treeOnly: true, schedule: false });
  try {
    const first = await backups.status(owner.id);
    assert.equal(first.settings.enabled, false);
    assert.equal(first.settings.keepCount, 5);
    assert.equal(first.nextRunAt, null);
    await backups.tick();
    assert.equal((await backups.status(owner.id)).total, 0);
    await assert.rejects(backups.startCreate(owner, true));
    for (let i = 0; i < 6; i++) { await backups.startCreate(owner); await backups.idle(); }
    const status = await backups.status(owner.id);
    assert.equal(status.job?.state, "succeeded", status.job?.error);
    assert.equal(status.total, 5);
    await backups.withFile(status.records[0].id, async (file) => {
      const entries = execFileSync("tar", ["-tzf", file], { encoding: "utf8" });
      assert.match(entries, /drevo.sqlite/);
      assert.match(entries, /11111111-1111-4111-8111-111111111111.png/);
      assert.doesNotMatch(entries, /unreferenced|foreign|secrets.key|archives/);
      const extracted = join(f.root, "inspection"); await mkdir(extracted);
      execFileSync("tar", ["-xzf", file, "-C", extracted]);
      const db = new DatabaseSync(join(extracted, "drevo.sqlite"), { readOnly: true });
      try {
        assert.equal(db.prepare("SELECT count(*) AS n FROM auth_sessions").get()!.n, 0);
        assert.equal(db.prepare("SELECT count(*) AS n FROM ai_settings").get()!.n, 0);
        assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
        assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
      } finally { db.close(); }
    });
  } finally { await backups.close(); await f.close(); }
});

test("platform native SQLite copy includes keys and originals, has a distinct catalog, and restores in isolation", async () => {
  const f = await fixture();
  const backups = await platformBackupCoordinator(f.archive.db, f.path, { schedule: false });
  try {
    await backups.startCreate(); await backups.idle();
    const status = await backups.status();
    assert.equal(status.job?.state, "succeeded", status.job?.error);
    assert.equal(status.total, 1); assert.match(status.records[0].name, /^platform-/);
    await backups.withFile(status.records[0].id, async (file) => {
      const restored = join(f.root, "isolated-recovery"); await mkdir(restored);
      execFileSync("tar", ["-xzf", file, "-C", restored]);
      const manifest = JSON.parse(await readFile(join(restored, "platform-manifest.json"), "utf8"));
      assert.equal(manifest.restoreMode, "offline");
      assert.equal(manifest.format, "drevo-platform");
      assert.deepEqual(await readFile(join(restored, "shared", "drevo.sqlite.secrets.key")), Buffer.alloc(32, 7));
      assert.equal(await readFile(join(restored, "shared", "uploads", "unreferenced.pdf"), "utf8"), "foreign or abandoned original");
      const isolated = await openArchive(join(restored, "platform.sqlite"), seed);
      try { assert.equal((await isolated.read()).family.title, seed.title); }
      finally { await isolated.close(); }
    });
    await assert.rejects(backups.withFile("other-tree-record", async () => {}));
  } finally { await backups.close(); await f.close(); }
});
