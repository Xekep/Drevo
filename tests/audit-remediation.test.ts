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
import {
  documentUploadQuota,
  UploadQuotaError,
} from "../src/server/document-upload-quota.ts";
import type { ArchiveUser } from "../src/domain/access.ts";
import type { Family, Person } from "../src/domain/types.ts";

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

test("public albums do not publish orphan uploads or portraits from a private tree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-public-media-"));
  const oldOrigin = process.env.PUBLIC_ORIGIN,
    oldPrivate = process.env.ARCHIVE_PRIVATE;
  process.env.PUBLIC_ORIGIN = "https://test.invalid";
  delete process.env.ARCHIVE_PRIVATE;
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  try {
    const url = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const settings = settingsStore(app.archive.db);
    assert.equal(settings.read().publicTree, false);
    assert.equal(settings.read().publicAlbums, false);
    assert.equal((await fetch(url + "/api/family")).status, 401);
    const data = family();
    data.people[0].photo = "/media/portrait.png";
    data.photos = [
      { id: "album", title: "Снимок", url: "/media/album.png", tags: [] },
    ];
    app.archive.write(data, app.archive.meta().revision);
    const png = await sharp({
      create: { width: 2, height: 2, channels: 3, background: "green" },
    })
      .png()
      .toBuffer();
    for (const name of ["portrait", "album", "orphan"])
      writeFileSync(join(dir, "uploads", name + ".png"), png);
    settings.write({ publicTree: false, publicAlbums: true });
    assert.equal((await fetch(url + "/media/album.png")).status, 200);
    for (const name of ["portrait", "orphan"])
      for (const suffix of ["", "?variant=thumb"])
        assert.equal(
          (await fetch(url + `/media/${name}.png${suffix}`)).status,
          401,
        );
    settings.write({ publicTree: true, publicAlbums: true });
    assert.equal(
      (await fetch(url + "/media/portrait.png?variant=thumb")).status,
      200,
    );
    assert.equal((await fetch(url + "/media/orphan.png")).status, 401);
    for (let i = 0; i < 60; i++)
      assert.equal((await fetch(url + "/api/people/search?q=те")).status, 200);
    assert.equal((await fetch(url + "/api/people/search?q=те")).status, 429);
    data.photos = [];
    app.archive.write(data, app.archive.meta().revision);
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

test("card patches merge independent edits, reject conflicting dates/ownership and retain recoverable history", () => {
  const db = openArchive(":memory:", family());
  try {
    const initial = db.read();
    db.db.exec(
      "CREATE TABLE changed(id TEXT); CREATE TRIGGER changed_person AFTER UPDATE ON people BEGIN INSERT INTO changed VALUES(NEW.id); END;",
    );
    const name = {
      collection: "people" as const,
      id: "father",
      field: "name",
      before: "father",
      after: "Отец",
    };
    const first = db.patchPeople([name], initial.revision, admin)!;
    assert.deepEqual(
      db.db
        .prepare("SELECT id FROM changed")
        .all()
        .map((r) => r.id),
      ["father"],
    );
    assert.ok(
      String(
        db.db
          .prepare("SELECT data FROM history WHERE revision=?")
          .get(initial.revision)!.data,
      ).length < 500,
    );
    const second = db.patchPeople(
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
    )!;
    assert.equal(second.baseRevision, first.revision);
    assert.equal(
      db.patchPeople([name], initial.revision, admin)!.revision,
      second.revision,
      "retry is idempotent",
    );
    assert.throws(
      () =>
        db.patchPeople([{ ...name, after: "Другой" }], initial.revision, admin),
      ConflictError,
    );
    assert.throws(
      () =>
        db.patchPeople(
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
    assert.equal(db.meta().revision, second.revision);
    assert.deepEqual(
      db.readRevision(initial.revision).people,
      initial.family.people,
    );
    assert.throws(
      () =>
        db.patchPeople(
          [{ ...name, before: "Отец", after: "Чужой" }],
          second.revision,
          { ...admin, id: "outsider", role: "relative" },
        ),
      /свои карточки/,
    );
    assert.throws(
      () =>
        db.patchPeople([name], second.revision, { ...admin, role: "reader" }),
      /просмотр/,
    );
    const structure = db.read();
    structure.family.people.push(person("third", "2000"));
    db.write(structure.family, structure.revision);
    assert.deepEqual(
      db.readRevision(initial.revision).people,
      initial.family.people,
      "mixed snapshots and patches restore exactly",
    );
  } finally {
    db.close();
  }
});

test("PDF reservations enforce disk headroom, total quota, concurrency and hourly limit across connections", () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-quota-"));
  const first = openArchive(join(dir, "db.sqlite"), family());
  const second = openArchive(join(dir, "db.sqlite"), family());
  let now = 1_000_000;
  try {
    const options = {
      bytes: 100,
      freeReserve: 10,
      requestsPerHour: 2,
      concurrent: 2,
      now: () => now,
    };
    const a = documentUploadQuota(first.db, options),
      b = documentUploadQuota(second.db, options);
    assert.throws(
      () => a.acquire("u", 20, 1000, { files: 1, bytes: 90 }),
      (e) => e instanceof UploadQuotaError && e.status === 507,
    );
    assert.throws(
      () => a.acquire("u", 60, 65),
      (e) => e instanceof UploadQuotaError && e.status === 507,
    );
    const release = a.acquire("u", 60, 1000);
    assert.throws(
      () => b.acquire("v", 60, 1000),
      (e) => e instanceof UploadQuotaError && e.status === 507,
    );
    release();
    b.acquire("u", 60, 1000)();
    assert.throws(
      () => a.acquire("u", 1, 1000),
      (e) => e instanceof UploadQuotaError && e.status === 429,
    );
    now += 3600_001;
    a.acquire("u", 60, 1000)();
    const firstPending = a.acquire("one", 1, 1000);
    const secondPending = b.acquire("two", 1, 1000);
    assert.throws(
      () => a.acquire("three", 1, 1000),
      (e) => e instanceof UploadQuotaError && e.status === 429,
    );
    firstPending();
    secondPending();
    first.db
      .prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?)")
      .run("existing", "Doc", "doc", "file.pdf", 90, "u", "2026-09-25");
    assert.throws(
      () => b.acquire("v", 20, 1000),
      (e) => e instanceof UploadQuotaError && e.status === 507,
    );
  } finally {
    first.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deployment preflight rejects an incompatible previous release without modifying the backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-migration-"));
  const path = join(dir, "backup.sqlite");
  const db = openArchive(path, family());
  const revision = db.meta().revision;
  db.close();
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
    const after = openArchive(path, family());
    try {
      assert.equal(after.meta().revision, revision);
    } finally {
      after.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
