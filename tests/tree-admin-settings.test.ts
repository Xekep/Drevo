import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { settingsStore } from "../src/server/settings.ts";
import { publishedPeopleStore } from "../src/server/published-people.ts";
import { defaultPublicationFields } from "../src/shared/publication.ts";
import { openArchive } from "../src/server/database.ts";
import { backupCoordinator } from "../src/server/backup-coordinator.ts";

test("whole-archive public grants cannot be enabled or restored from old settings", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-private-settings-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  try {
    await app.archive.db.prepare("UPDATE access_settings SET public_tree=1,public_albums=1").run();
    const visibility = await settingsStore(app.archive.db);
    assert.deepEqual(await visibility.read(), { publicTree: false, publicAlbums: false, reverseTimeline: false });
    await assert.rejects(visibility.write({ publicTree: true, publicAlbums: false }), /временную ссылку/);
    await assert.rejects(visibility.write({ publicTree: false, publicAlbums: true }), /временную ссылку/);
    await visibility.write({ publicTree: false, publicAlbums: false, reverseTimeline: true });
    // An imported snapshot can still contain old columns; they grant no access.
    await app.archive.db.prepare("UPDATE access_settings SET public_tree=1,public_albums=1").run();
    assert.deepEqual(await visibility.read(), { publicTree: false, publicAlbums: false, reverseTimeline: true });
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("tree backup limit persists, rotates only after a successful new copy and permits explicit deletion", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-tree-retention-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/backups`;
  const send = (path: string, method: string, body?: unknown) => fetch(base + path, {
    method, headers: { "Content-Type": "application/json", "X-Drevo-Backup": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const completed = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const status = await fetch(base).then(response => response.json());
      if (status.job?.state !== "running") { assert.equal(status.job?.state, "succeeded", status.job?.error); return status; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error("Backup did not finish");
  };
  try {
    assert.equal((await send("/settings", "PUT", { keepCount: 2 })).status, 200);
    for (const body of [{ keepCount: 0 }, { keepCount: 366 }, { keepCount: 1.5 },
      { keepCount: 2, enabled: true }, { keepCount: 2, storage: "remote" }])
      assert.equal((await send("/settings", "PUT", body)).status, 400);
    assert.equal((await fetch(base).then(response => response.json())).settings.keepCount, 2);
    const stored = await app.archive.db.prepare("SELECT data FROM backup_settings WHERE id=1").get();
    assert.equal(JSON.parse(String(stored!.data)).treeKeepCount, 2);
    for (let i = 0; i < 3; i++) {
      assert.equal((await send("/create", "POST")).status, 202);
      await completed();
    }
    const status = await fetch(base).then(response => response.json());
    assert.equal(status.total, 2);
    assert.equal((await send("/settings", "PUT", { keepCount: 1 })).status, 200);
    assert.equal((await fetch(base).then(response => response.json())).total, 2,
      "saving a smaller limit does not immediately remove copies");
    const deleted = status.records[0];
    assert.equal((await send("/" + deleted.id, "DELETE")).status, 202);
    assert.equal((await completed()).total, 1);
    await assert.rejects(access(join(directory, "tree-backups", deleted.name)), { code: "ENOENT" });
    assert.equal((await send("/" + deleted.id, "DELETE")).status, 400);
    assert.equal((await send("/create", "POST")).status, 202);
    assert.equal((await completed()).total, 1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("publication management lists only explicitly published IDs and reflects revocation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-published-index-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const first = await app.archive.read();
    const person = { id: "visible", name: "Анна", surname: "Тестова", patronymic: "",
      sex: "f" as const, birth: "1900", death: "1980", birthPlace: "", sources: [], parents: [], spouses: [], generation: 1, column: 0 };
    await app.archive.write({ ...first.family, people: [person, { ...person, id: "hidden" }] }, first.revision);
    const publications = publishedPeopleStore(app.archive.db);
    await publications.publish("visible", "local");
    const index = () => fetch(base + "/api/admin/published-people/batch?published=1").then(response => response.json());
    assert.deepEqual((await index()).fields, { visible: defaultPublicationFields });
    await publications.unpublish("visible");
    assert.deepEqual((await index()).fields, {});
    assert.equal((await fetch(base + "/api/admin/published-people/batch?published=1&id=visible")).status, 400);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("retention preserves the new copy when the server clock moves backwards", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-clock-retention-"));
  const path = join(directory, "archive.sqlite");
  const archive = await openArchive(path, { title: "Архив", description: "", demo: false, people: [] });
  let now = Date.now();
  const backups = await backupCoordinator(archive.db, path, { treeOnly: true, schedule: false, now: () => now });
  const actor = { id: "local", name: "Владелец", role: "admin" as const, approved: true, createdAt: "" };
  try {
    await backups.save({ keepCount: 1 }, actor);
    await backups.startCreate(actor); await backups.idle();
    const first = (await backups.status(actor.id)).records[0];
    assert.ok(first);
    now -= 60_000;
    await backups.startCreate(actor); await backups.idle();
    const after = await backups.status(actor.id);
    assert.equal(after.job?.state, "succeeded", after.job?.error ?? "Backup failed");
    assert.equal(after.total, 1);
    assert.notEqual(after.records[0].id, first.id);
  } finally { await backups.close(); await archive.close(); await rm(directory, { recursive: true, force: true }); }
});
