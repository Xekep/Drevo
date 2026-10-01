import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import sharp from "sharp";
import { openArchive, ConflictError } from "../src/server/database.ts";
import { settingsStore } from "../src/server/settings.ts";
import { startServer } from "../src/server/index.ts";
import { uploadQuota, UploadQuotaError } from "../src/server/upload-quota.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { registerMediaUpload } from "../src/server/media-access.ts";

const person = (id: string, birth: string, parents: string[] = []): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex: "m",
  birth,
  birthPlace: "",
  parents,
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  createdBy: "owner",
});
const family = (): Family => ({
  title: "Тест",
  description: "",
  demo: false,
  people: [person("father", "1950"), person("child", "1980", ["father"])],
});
const admin: ArchiveUser = {
  id: "admin",
  name: "Администратор",
  role: "admin",
  approved: true,
  createdAt: "",
};

test("scoped media assignments require ownership, retain portrait undo and reject another user's uploads", async () => {
  const seed = family();
  seed.people[0].photo = "/media/previous.png";
  seed.people.push({
    ...person("hidden", "1950"),
    createdBy: "other",
    photo: "/media/hidden.png",
  });
  const archive = await openArchive(":memory:", seed);
  const user: ArchiveUser = {
    ...admin,
    id: "owner",
    role: "relative",
    personId: "father",
    treeAccess: "common_ancestors",
  };
  const assign = async (url?: string) => {
    const current = await archive.read();
    current.family.people[0].photo = url;
    return await archive.write(current.family, current.revision, user);
  };
  try {
    await assign(undefined);
    await assign("/media/previous.png");
    await assert.rejects(
      async () => await assign("/media/hidden.png"),
      /Нет доступа/,
    );
    const removeOther = await registerMediaUpload(
      archive.db,
      "/media/new.png",
      "other",
      1,
    );
    await assert.rejects(
      async () => await assign("/media/new.png"),
      /Нет доступа/,
    );
    await removeOther();
    await registerMediaUpload(archive.db, "/media/new.png", user.id, 1);
    await archive.db.exec("UPDATE media_upload_grants SET expires_ms=0");
    await assert.rejects(
      async () => await assign("/media/new.png"),
      /Нет доступа/,
    );
    await registerMediaUpload(archive.db, "/media/new.png", user.id, 1);
    await assign("/media/new.png");
    await archive.db.exec("DELETE FROM media_upload_grants");
    await assign("/media/previous.png");
    assert.equal(
      (await archive.read()).family.people[0].photo,
      "/media/previous.png",
    );
  } finally {
    await archive.close();
  }
});

test("public albums do not publish orphan uploads or portraits from a private tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-public-media-"));
  const oldOrigin = process.env.PUBLIC_ORIGIN,
    oldPrivate = process.env.ARCHIVE_PRIVATE;
  process.env.PUBLIC_ORIGIN = "https://test.invalid";
  delete process.env.ARCHIVE_PRIVATE;
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  try {
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const settings = await settingsStore(app.archive.db);
    assert.equal((await settings.read()).publicTree, false);
    assert.equal((await settings.read()).publicAlbums, false);
    assert.equal((await fetch(url + "/api/family")).status, 401);
    const data = family();
    data.people[0].photo = "/media/portrait.png";
    data.photos = [
      { id: "album", title: "Снимок", url: "/media/album.png", tags: [] },
    ];
    await app.archive.write(data, (await app.archive.meta()).revision);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    for (const name of ["portrait", "album", "orphan"])
      writeFileSync(join(dir, "uploads", name + ".png"), png);
    await settings.write({ publicTree: false, publicAlbums: true });
    assert.equal((await fetch(url + "/media/album.png")).status, 200);
    for (const name of ["portrait", "orphan"])
      for (const suffix of ["", "?variant=thumb"])
        assert.equal(
          (await fetch(url + `/media/${name}.png${suffix}`)).status,
          401,
        );
    await settings.write({ publicTree: true, publicAlbums: true });
    assert.equal(
      (await fetch(url + "/media/portrait.png?variant=thumb")).status,
      200,
    );
    assert.equal((await fetch(url + "/media/orphan.png")).status, 401);
    for (let i = 0; i < 60; i++)
      assert.equal((await fetch(url + "/api/people/search?q=те")).status, 200);
    assert.equal((await fetch(url + "/api/people/search?q=те")).status, 429);
    data.photos = [];
    await app.archive.write(data, (await app.archive.meta()).revision);
    assert.equal(
      (await fetch(url + "/media/album.png")).status,
      401,
      "history retention must not publish a deleted photo",
    );
  } finally {
    await app.close();
    if (oldOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = oldOrigin;
    if (oldPrivate === undefined) delete process.env.ARCHIVE_PRIVATE;
    else process.env.ARCHIVE_PRIVATE = oldPrivate;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("card patches merge independent edits, reject conflicting dates/ownership and retain recoverable history", async () => {
  const db = await openArchive(":memory:", family());
  try {
    const initial = await db.read();
    await db.db.exec(
      "CREATE TABLE changed(id TEXT); CREATE TRIGGER changed_person AFTER UPDATE ON people BEGIN INSERT INTO changed VALUES(NEW.id); END;",
    );
    const name = {
      collection: "people" as const,
      id: "father",
      field: "name",
      before: "father",
      after: "Отец",
    };
    const first = (await db.patchPeople([name], initial.revision, admin))!;
    assert.deepEqual(
      (await db.db.prepare("SELECT id FROM changed").all()).map((r) => r.id),
      ["father"],
    );
    assert.ok(
      String(
        (await db.db
          .prepare("SELECT data FROM history WHERE revision=?")
          .get(initial.revision))!.data,
      ).length < 500,
    );
    const second = (await db.patchPeople(
      [
        {
          collection: "people",
          id: "child",
          field: "biography",
          before: undefined,
          after: "Запись",
        },
      ],
      initial.revision,
      admin,
    ))!;
    assert.equal(second.baseRevision, first.revision);
    assert.equal(
      (await db.patchPeople([name], initial.revision, admin))!.revision,
      second.revision,
      "retry is idempotent",
    );
    await assert.rejects(
      async () =>
        await db.patchPeople(
          [{ ...name, after: "Другой" }],
          initial.revision,
          admin,
        ),
      ConflictError,
    );
    await assert.rejects(
      async () =>
        await db.patchPeople(
          [
            {
              collection: "people",
              id: "father",
              field: "birth",
              before: "1950",
              after: "1990",
            },
          ],
          second.revision,
          admin,
        ),
      /раньше ребёнка/,
    );
    assert.equal((await db.meta()).revision, second.revision);
    assert.deepEqual(
      (await db.readRevision(initial.revision)).people,
      initial.family.people,
    );
    await assert.rejects(
      async () =>
        await db.patchPeople(
          [{ ...name, before: "Отец", after: "Чужой" }],
          second.revision,
          { ...admin, id: "outsider", role: "relative" },
        ),
      /свои карточки/,
    );
    await assert.rejects(
      async () =>
        await db.patchPeople([name], second.revision, {
          ...admin,
          role: "reader",
        }),
      /просмотр/,
    );
    const structure = await db.read();
    structure.family.people.push(person("third", "2000"));
    await db.write(structure.family, structure.revision);
    assert.deepEqual(
      (await db.readRevision(initial.revision)).people,
      initial.family.people,
      "mixed snapshots and patches restore exactly",
    );
  } finally {
    await db.close();
  }
});

test("upload reservations enforce disk headroom, total quota, concurrency and hourly limit across connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-quota-"));
  const first = await openArchive(join(dir, "db.sqlite"), family());
  const second = await openArchive(join(dir, "db.sqlite"), family());
  let now = 1_000_000;
  try {
    const options = {
      bytes: 100,
      freeReserve: 10,
      requestsPerHour: 2,
      concurrent: 2,
      now: () => now,
    };
    const a = uploadQuota(first.db, options),
      b = uploadQuota(second.db, options);
    await assert.rejects(
      async () => await a.acquire("u", 20, 1000, { files: 1, bytes: 90 }),
      (e) => e instanceof UploadQuotaError && e.status === 507,
    );
    await assert.rejects(
      async () => await a.acquire("u", 60, 65),
      (e) => e instanceof UploadQuotaError && e.status === 507,
    );
    const release = await a.acquire("u", 60, 1000);
    await assert.rejects(
      async () => await b.acquire("v", 60, 1000),
      (e) => e instanceof UploadQuotaError && e.status === 507,
    );
    await release();
    await (
      await b.acquire("u", 60, 1000)
    )();
    await assert.rejects(
      async () => await a.acquire("u", 1, 1000),
      (e) => e instanceof UploadQuotaError && e.status === 429,
    );
    now += 3600_001;
    await (
      await a.acquire("u", 60, 1000)
    )();
    await assert.rejects(
      async () => await b.acquire(
        "fresh", 20, async () => 1000,
        async () => ({ files: 1, bytes: 90 }),
      ),
      (e) => e instanceof UploadQuotaError && e.status === 507,
      "a live filesystem measurement must be checked inside the reservation",
    );
    const firstPending = await a.acquire("one", 1, 1000);
    const secondPending = await b.acquire("two", 1, 1000);
    await assert.rejects(
      async () => await a.acquire("three", 1, 1000),
      (e) => e instanceof UploadQuotaError && e.status === 429,
    );
    await firstPending();
    await secondPending();
    await first.db
      .prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
      )
      .run("existing", "Doc", "doc", "file.pdf", 90, "u", "2026-09-25");
    await assert.rejects(
      async () => await b.acquire("v", 20, 1000),
      (e) => e instanceof UploadQuotaError && e.status === 507,
    );
  } finally {
    await first.close();
    await second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deployment preflight rejects an incompatible previous release without modifying the backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-migration-"));
  const path = join(dir, "backup.sqlite");
  const db = await openArchive(path, family());
  const revision = (await db.meta()).revision;
  await db.close();
  try {
    mkdirSync(join(dir, "old", "src", "server"), { recursive: true });
    writeFileSync(
      join(dir, "old", "src", "server", "index.ts"),
      "export function startServer() { throw new Error('Incompatible schema'); }",
    );
    const result = spawnSync(
      process.execPath,
      ["ops/check-migration.mjs", path, resolve("."), join(dir, "old")],
      { encoding: "utf8", timeout: 90_000 },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Incompatible schema/);
    const after = await openArchive(path, family());
    try {
      assert.equal((await after.meta()).revision, revision);
    } finally {
      await after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
