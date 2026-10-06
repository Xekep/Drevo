import { storeDatabase } from "../src/server/store-database.ts";
import { validateBackupSettings } from "../src/server/backup-store.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  copyFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { openArchive } from "../src/server/database.ts";
import {
  backupCoordinator,
  BackupBusyError,
} from "../src/server/backup-coordinator.ts";
import type { BackupRemote } from "../src/server/backup-remote.ts";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";
import type { ArchiveUser } from "../src/domain/access.ts";

const actor: ArchiveUser = {
  id: "local",
  name: "Администратор",
  role: "admin",
  approved: true,
  createdAt: "",
};
const seed = {
  title: "До изменения",
  description: "",
  demo: false,
  people: [],
  photos: [],
  links: [],
};
async function fixture(remote?: BackupRemote) {
  const directory = mkdtempSync(join(tmpdir(), "drevo-managed-backup-")),
    path = join(directory, "drevo.sqlite");
  mkdirSync(join(directory, "uploads"));
  const archive = await openArchive(path, seed);
  let clock = Date.now();
  const manager = await backupCoordinator(archive.db, path, {
    schedule: false,
    now: () => clock,
    remote,
  });
  return {
    directory,
    path,
    archive,
    manager,
    advance: (hours: number) => {
      clock += hours * 3600000;
    },
    async close() {
      await manager.close();
      await archive.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("full managed copy includes database, files and encryption key; count retention keeps safety snapshots", async () => {
  const f = await fixture();
  try {
    writeFileSync(f.path + ".secrets.key", Buffer.alloc(32, 42));
    writeFileSync(
      join(f.directory, "uploads", "test-file.jpg"),
      "image-original",
    );
    writeFileSync(
      join(f.directory, "uploads", ".pending-upload"),
      "incomplete-secret",
    );
    const untouched = join(
      f.directory,
      "backups",
      "before-import-sentinel.sqlite",
    );
    writeFileSync(untouched, "keep");
    await f.manager.save(
      { ...(await f.manager.status(actor.id)).settings, keepCount: 2 },
      actor,
    );
    for (let i = 0; i < 3; i++) {
      assert.equal((await f.manager.startCreate(actor))?.state, "running");
      await assert.rejects(
        async () => await f.manager.startCreate(actor),
        BackupBusyError,
      );
      await f.manager.idle();
      assert.equal(
        (await f.manager.status(actor.id)).job?.state,
        "succeeded",
        (await f.manager.status(actor.id)).job?.error,
      );
      f.advance(1);
    }
    const status = await f.manager.status(actor.id);
    assert.equal(status.records.length, 2);
    assert.equal(
      readdirSync(join(f.directory, "backups")).filter((n) =>
        n.endsWith(".tar.gz"),
      ).length,
      2,
    );
    assert.equal(readFileSync(untouched, "utf8"), "keep");
    await f.manager.withFile(status.records[0].id, async (file) => {
      const content = gunzipSync(readFileSync(file));
      assert.ok(content.includes(Buffer.from("drevo.sqlite.secrets.key")));
      assert.ok(content.includes(Buffer.alloc(32, 42)));
      assert.ok(content.includes(Buffer.from("image-original")));
      assert.ok(!content.includes(Buffer.from("incomplete-secret")));
    });
    writeFileSync(
      join(f.directory, "backups", status.records[0].name),
      "corrupted",
    );
    await assert.rejects(
      f.manager.withFile(status.records[0].id, async () =>
        assert.fail("must not read corrupt copy"),
      ),
      /Контрольная сумма/,
    );
  } finally {
    await f.close();
  }
});

test("schedule and lease survive another instance; disabled schedule never creates a copy", async () => {
  const f = await fixture();
  const connection = new DatabaseSync(f.path);
  const other = await backupCoordinator(storeDatabase(connection), f.path, {
    schedule: false,
  });
  try {
    await f.manager.save(
      { ...(await f.manager.status(actor.id)).settings, intervalHours: 1 },
      actor,
    );
    f.advance(1);
    await f.manager.tick();
    await assert.rejects(
      async () => await other.startCreate(actor),
      BackupBusyError,
    );
    await f.manager.idle();
    const id = (await f.manager.status(actor.id)).job!.id;
    await f.manager.tick();
    await f.manager.idle();
    assert.equal((await f.manager.status(actor.id)).job!.id, id);
    assert.equal((await other.status(actor.id)).records.length, 1);
    await f.manager.save(
      { ...(await f.manager.status(actor.id)).settings, enabled: false },
      actor,
    );
    f.advance(48);
    await f.manager.tick();
    await f.manager.idle();
    assert.equal((await f.manager.status(actor.id)).job!.id, id);
    assert.equal((await f.manager.status(actor.id)).nextRunAt, null);
  } finally {
    await other.close();
    connection.close();
    await f.close();
  }
});

test("remote copies restore from original destination after settings change; failed upload never prunes", async () => {
  const vault = mkdtempSync(join(tmpdir(), "drevo-test-vault-"));
  let fail = false,
    removed = 0;
  const remote: BackupRemote = {
    config: "/fixed/config",
    async check() {},
    async upload(_target, name, file, hash) {
      if (fail) throw new Error("Remote offline");
      assert.equal(
        createHash("sha256").update(readFileSync(file)).digest("hex"),
        hash,
      );
      copyFileSync(file, join(vault, name));
    },
    async download(record, file) {
      assert.equal(record.remoteHost, "vault-one");
      copyFileSync(join(vault, record.name), file);
    },
    async remove(record) {
      removed++;
      rmSync(join(vault, record.name));
    },
  };
  const f = await fixture(remote);
  try {
    await f.manager.save(
      {
        ...(await f.manager.status(actor.id)).settings,
        storage: "remote",
        remoteHost: "vault-one",
        remoteDirectory: "/srv/backups/drevo",
        keepCount: 1,
      },
      actor,
    );
    await f.manager.startCreate(actor);
    await f.manager.idle();
    const first = (await f.manager.status(actor.id)).records[0];
    assert.ok(first);
    assert.equal(existsSync(join(f.directory, "backups", first.name)), false);
    fail = true;
    await f.manager.startCreate(actor);
    await f.manager.idle();
    assert.equal((await f.manager.status(actor.id)).job?.state, "failed");
    assert.equal(removed, 0);
    assert.ok(existsSync(join(vault, first.name)));
    fail = false;
    f.advance(1);
    await f.manager.startCreate(actor);
    await f.manager.idle();
    assert.equal(removed, 1);
    const second = (await f.manager.status(actor.id)).records[0];
    await f.manager.save(
      {
        ...(await f.manager.status(actor.id)).settings,
        storage: "local",
        remoteHost: "vault-two",
      },
      actor,
    );
    await f.manager.withFile(second.id, async (file) =>
      assert.ok(readFileSync(file).length),
    );
    assert.equal(
      readdirSync(join(f.directory, "backups")).some((n) =>
        n.startsWith(".download-"),
      ),
      false,
    );
  } finally {
    await f.close();
    rmSync(vault, { recursive: true, force: true });
  }
});

test("settings reject shell options, paths outside storage and unbounded schedules", () => {
  const good = {
    enabled: true,
    intervalHours: 24,
    keepCount: 7,
    storage: "remote",
    remoteHost: "vault",
    remoteDirectory: "/srv/backups",
  };
  assert.doesNotThrow(() => validateBackupSettings(good));
  for (const patch of [
    { remoteHost: "-oProxyCommand=cmd" },
    { remoteHost: "host;reboot" },
    { remoteDirectory: "/srv/../etc" },
    { remoteDirectory: "/srv/$(id)" },
    { keepCount: 0 },
    { intervalHours: 0 },
    { intervalHours: 1.5 },
    { enabled: "yes" },
  ])
    assert.throws(() => validateBackupSettings({ ...good, ...patch }));
});

test("retention cannot remove the bytes of a backup being downloaded", async () => {
  const f = await fixture();
  try {
    await f.manager.save(
      { ...(await f.manager.status(actor.id)).settings, keepCount: 1 },
      actor,
    );
    await f.manager.startCreate(actor);
    await f.manager.idle();
    const copy = (await f.manager.status(actor.id)).records[0];
    await f.manager.withFile(copy.id, async (file) => {
      const expected = readFileSync(file);
      f.advance(1);
      await f.manager.startCreate(actor);
      await f.manager.idle();
      assert.equal(existsSync(join(f.directory, "backups", copy.name)), false);
      assert.deepEqual(readFileSync(file), expected);
    });
    assert.equal(
      readdirSync(join(f.directory, "backups")).some((n) =>
        n.startsWith(".download-"),
      ),
      false,
    );
  } finally {
    await f.close();
  }
});

test("restart exposes interrupted job and does not disclose another administrator's restore token", async () => {
  const f = await fixture();
  try {
    await f.manager.startCreate(actor);
    await f.manager.idle();
    const copy = (await f.manager.status(actor.id)).records[0];
    await f.manager.preview(copy.id, actor, async () => ({
      token: "private-token",
      title: "Preview",
      people: 0,
      photos: 0,
      files: 0,
      missing: 0,
      currentCommentsLost: 0,
      backupCommentsSkipped: 0,
      currentPeople: 0,
      currentPhotos: 0,
    }));
    await f.manager.idle();
    assert.equal(
      (await f.manager.status(actor.id)).job?.preview?.token,
      "private-token",
    );
    assert.equal(
      (await f.manager.status("other-admin")).job?.preview,
      undefined,
    );
    await f.archive.db
      .prepare("UPDATE backup_job SET data=?,lease_until=? WHERE id=1")
      .run(
        JSON.stringify({
          id: "interrupted",
          kind: "create",
          state: "running",
          startedAt: new Date().toISOString(),
        }),
        0,
      );
    assert.equal((await f.manager.status(actor.id)).job?.state, "failed");
    await f.manager.startCreate(actor);
    await f.manager.idle();
    assert.equal((await f.manager.status(actor.id)).job?.state, "succeeded");
  } finally {
    await f.close();
  }
});

test("all backup management endpoints reject guests, readers, relatives and unapproved admins", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-backup-access-"));
  const previous = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "https://backup-test.invalid";
  const app = await startServer(0, join(directory, "drevo.sqlite"), true);
  const base =
    "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
  try {
    const users = await userStore(app.archive.db);
    for (const [index, role, approved] of [
      [0, "reader", 1],
      [1, "relative", 1],
      [2, "admin", 0],
      [3, "admin", 1],
    ] as const) {
      const id = "backup-user-" + index;
      await users.register(id, id);
      await app.archive.db
        .prepare("UPDATE users SET role=?,approved=? WHERE id=?")
        .run(role, approved, id);
      const token = String(index).repeat(64);
      await app.archive.db
        .prepare("INSERT INTO auth_sessions VALUES(?,?,?)")
        .run(
          createHash("sha256").update(token).digest("hex"),
          id,
          Date.now() + 60000,
        );
      const endpoints = [
        ["", "GET"],
        ["/settings", "PUT"],
        ["/create", "POST"],
        ["/check", "POST"],
        ["/00000000-0000-0000-0000-000000000000/preview", "POST"],
        ["/00000000-0000-0000-0000-000000000000/download", "GET"],
      ];
      if (index === 3) {
        assert.equal(
          (
            await fetch(base + "/api/backups", {
              headers: { Cookie: "drevo_session=" + token },
            })
          ).status,
          200,
        );
        continue;
      }
      for (const [path, method] of endpoints) {
        assert.equal(
          (
            await fetch(base + "/api/backups" + path, {
              method,
              headers: {
                Cookie: "drevo_session=" + token,
                "X-Drevo-Backup": "1",
              },
            })
          ).status,
          403,
        );
        assert.equal(
          (
            await fetch(base + "/api/backups" + path, {
              method,
              headers: { "X-Drevo-Backup": "1" },
            })
          ).status,
          401,
        );
      }
    }
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("HTTP selected-backup preview requires explicit restore confirmation and revision; preserves current users", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-backup-http-"));
  const app = await startServer(0, join(directory, "drevo.sqlite"), true);
  const base =
    "http://127.0.0.1:" + (app.server.address() as { port: number }).port;
  const post = (path: string, body?: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: {
        "X-Drevo-Backup": "1",
        "X-Drevo-Restore": "1",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function done() {
    for (let i = 0; i < 150; i++) {
      const status = await (await fetch(base + "/api/backups")).json();
      if (status.job?.state !== "running") return status;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.fail("Backup timed out");
  }
  try {
    // Nginx's /api/backups/ proxy location redirects the slashless URI.
    // Both addresses must serve the list, including browsers that cached the 301.
    for (const path of ["/api/backups", "/api/backups/"]) {
      const response = await fetch(base + path + "?offset=0");
      assert.equal(response.status, 200, path);
      assert.equal((await response.json()).total, 0);
    }
    await app.archive.write(seed, (await app.archive.read()).revision);
    const settingsBefore = await app.archive.db.prepare("SELECT data,next_run FROM backup_settings WHERE id=1").get();
    const initialTreeStatus = await fetch(base + "/api/backups").then((response) => response.json());
    assert.equal(initialTreeStatus.settings.enabled, false);
    assert.equal(initialTreeStatus.settings.keepCount, 5);
    assert.equal(initialTreeStatus.settings.storage, "local");
    assert.equal(initialTreeStatus.nextRunAt, null);
    assert.equal((await fetch(base + "/api/backups/settings", {
      method: "PUT", headers: { "X-Drevo-Backup": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ ...initialTreeStatus.settings, enabled: true, keepCount: 30 }),
    })).status, 403, "even an authorized tree owner cannot enable per-tree scheduling");
    assert.deepEqual(await app.archive.db.prepare("SELECT data,next_run FROM backup_settings WHERE id=1").get(), settingsBefore);
    assert.equal((await post("/api/backups/check", { ...initialTreeStatus.settings,
      storage: "remote", remoteHost: "vault", remoteDirectory: "/backup" })).status, 403);
    assert.equal(
      (await fetch(base + "/api/backups/create", { method: "POST" })).status,
      403,
    );
    assert.equal(
      (
        await fetch(base + "/api/backups/create", {
          method: "POST",
          headers: { "X-Drevo-Backup": "1", Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.equal((await post("/api/backups/create")).status, 202);
    const saved = await done();
    assert.equal(saved.job.state, "succeeded", saved.job.error);
    const copy = saved.records[0];
    await app.archive.write(
      { ...seed, title: "После изменения" },
      (await app.archive.read()).revision,
    );
    await (
      await userStore(app.archive.db)
    ).register("still-here", "Новый участник");
    assert.equal(
      (await post("/api/backups/" + copy.id + "/preview")).status,
      202,
    );
    const staged = await done();
    assert.equal(staged.job.state, "succeeded", staged.job.error);
    assert.equal((await app.archive.read()).family.title, "После изменения");
    assert.equal(
      (
        await post("/api/restore/apply", {
          token: staged.job.preview.token,
          confirm: false,
        })
      ).status,
      400,
    );
    await app.archive.write(
      { ...seed, title: "Конкурентная правка" },
      (await app.archive.read()).revision,
    );
    assert.equal(
      (
        await post("/api/restore/apply", {
          token: staged.job.preview.token,
          confirm: true,
        })
      ).status,
      409,
    );
    await post("/api/backups/" + copy.id + "/preview");
    const again = await done();
    assert.equal(
      (
        await post("/api/restore/apply", {
          token: again.job.preview.token,
          confirm: true,
        })
      ).status,
      200,
    );
    assert.equal((await app.archive.read()).family.title, seed.title);
    assert.ok(await (await userStore(app.archive.db)).get("still-here"));
    assert.ok(
      readdirSync(join(directory, "backups")).some((n) =>
        n.startsWith("before-import-"),
      ),
    );
  } finally {
    await app.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Nginx proxies the slashless backup list without a permanent redirect", () => {
  assert.match(
    readFileSync("ops/nginx.conf", "utf8"),
    /location = \/api\/backups \{[\s\S]*?proxy_pass http:\/\/127\.0\.0\.1:3107;/,
  );
});
