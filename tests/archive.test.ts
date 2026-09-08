import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openArchive, ConflictError } from "../src/server/database.ts";
import { databaseBackup } from "../src/server/backup.ts";
import { startServer } from "../src/server/index.ts";
import { passwordHash } from "../src/server/auth.ts";
import {
  analyzeKinship,
  connectPeople,
  removePerson,
  validateFamily,
  type Family,
  type Person,
} from "../src/domain/index.ts";
const person = (id: string, birth = "1950", sex: "m" | "f" = "m"): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex,
  birth,
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
});
const seed = (): Family => ({
  title: "Тест",
  description: "",
  demo: false,
  people: [
    person("father"),
    person("mother", "1951", "f"),
    person("child", "1980"),
    person("other", "1981", "f"),
  ],
});
test("documented relationships preserve direction and coexist with blood kinship", () => {
  let f = connectPeople(seed(), "father", "child", "parent");
  f = connectPeople(f, "mother", "child", "godparent");
  const [father, mother, child] = f.people;
  assert.equal(
    analyzeKinship(mother, child, f.people, f.links).roles?.[0].term,
    "крёстная мать",
  );
  assert.equal(
    analyzeKinship(child, mother, f.people, f.links).roles?.[0].term,
    "крестник",
  );
  assert.equal(
    analyzeKinship(father, mother, f.people, f.links).roles?.[0].term,
    "кум",
  );
  f = connectPeople(f, "father", "child", "godparent");
  assert.equal(
    analyzeKinship(father, child, f.people, f.links).otherRelations?.[0]
      .roles?.[0].term,
    "крёстный отец",
  );
});
test("adoption, milk and sworn relationships do not invent blood parents", () => {
  let f = connectPeople(seed(), "mother", "child", "nurse");
  f = connectPeople(f, "mother", "other", "parent");
  assert.equal(
    analyzeKinship(f.people[2], f.people[3], f.people, f.links).roles?.[0].term,
    "молочный брат",
  );
  f = connectPeople(f, "father", "child", "adoptive_parent");
  assert.equal(
    analyzeKinship(f.people[0], f.people[2], f.people, f.links).roles?.[0].term,
    "приёмный отец",
  );
  assert.deepEqual(f.people[2].parents, []);
  assert.throws(() => connectPeople(f, "child", "father", "adoptive_parent"));
  f = connectPeople(f, "child", "other", "sworn_sibling");
  assert.throws(() => connectPeople(f, "other", "child", "sworn_sibling"));
});
test("SQLite persists graph and photo tags, rejects stale writes, makes readable standalone backup", () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-test-")),
    path = join(dir, "archive.sqlite");
  let store = openArchive(path, seed());
  try {
    const first = store.read();
    const family = connectPeople(first.family, "father", "child", "parent");
    family.photos = [
      {
        id: "photo",
        url: "/media/photo.png",
        title: "Снимок",
        tags: [
          {
            id: "tag",
            personId: "child",
            x: 0.1,
            y: 0.2,
            width: 0.3,
            height: 0.4,
          },
        ],
      },
    ];
    const saved = store.write(family, first.revision);
    assert.throws(
      () => store.write(first.family, first.revision),
      ConflictError,
    );
    assert.equal(store.read().revision, saved.revision);
    const invalid = structuredClone(saved.family);
    invalid.photos![0].tags[0].width = 2;
    assert.throws(() => store.write(invalid, saved.revision));
    assert.deepEqual(store.read(), saved);
    const backup = join(dir, "backup.sqlite");
    writeFileSync(backup, databaseBackup(store.db));
    const db = new DatabaseSync(backup);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM photo_tags").get()!.n,
      1,
    );
    assert.equal(
      db.prepare("PRAGMA integrity_check").get()!.integrity_check,
      "ok",
    );
    db.close();
    store.close();
    store = openArchive(path, seed());
    assert.deepEqual(store.read(), saved);
    const removed = removePerson(saved.family, "child");
    assert.equal(removed.photos![0].tags.length, 0);
    store.write({ ...seed(), people: [] }, saved.revision);
    store.close();
    store = openArchive(path, seed());
    assert.equal(store.read().family.people.length, 0);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("photo tag geometry must stay within image and refer to an existing person", () => {
  const f = seed();
  f.photos = [
    {
      id: "p",
      url: "/media/p.png",
      title: "",
      tags: [{ id: "t", personId: "missing", x: 0, y: 0, width: 1, height: 1 }],
    },
  ];
  assert.throws(() => validateFamily(f));
  f.photos[0].tags[0].personId = "father";
  assert.doesNotThrow(() => validateFamily(f));
  f.photos[0].tags[0].x = 0.1;
  assert.throws(() => validateFamily(f));
});
test("HTTP login gates edits and backups; uploaded photo and tags survive a round trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-http-"));
  process.env.PUBLIC_ORIGIN = "https://drevo.kiiko.ru";
  process.env.ARCHIVE_PASSWORD_HASH = await passwordHash("test-password-long");
  const app = await startServer(0, join(dir, "db.sqlite"), true),
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    let response = await fetch(base + "/api/family");
    let snapshot = await response.json();
    assert.equal(snapshot.canEdit, false);
    assert.equal((await fetch(base + "/api/backup")).status, 401);
    assert.equal(
      (
        await fetch(base + "/api/family", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            "If-Match": String(snapshot.revision),
          },
          body: JSON.stringify(snapshot.family),
        })
      ).status,
      401,
    );
    response = await fetch(base + "/api/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://drevo.kiiko.ru",
      },
      body: JSON.stringify({
        username: "xekep",
        password: "test-password-long",
      }),
    });
    assert.equal(response.status, 200);
    const cookie = response.headers.get("set-cookie")!.split(";")[0];
    assert.match(
      response.headers.get("set-cookie")!,
      /HttpOnly.*SameSite=Strict.*Secure/,
    );
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aR9sAAAAASUVORK5CYII=",
      "base64",
    );
    response = await fetch(base + "/api/photos", {
      method: "POST",
      headers: {
        Cookie: cookie,
        "If-Match": String(snapshot.revision),
        "X-Drevo-Upload": "1",
        "Content-Type": "image/png",
      },
      body: png,
    });
    assert.equal(response.status, 201);
    snapshot = await response.json();
    const photo = snapshot.family.photos.at(-1);
    response = await fetch(base + photo.url);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
    photo.tags = [
      {
        id: "tag",
        personId: snapshot.family.people[0].id,
        x: 0.2,
        y: 0.3,
        width: 0.2,
        height: 0.3,
      },
    ];
    response = await fetch(base + "/api/family", {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "If-Match": String(snapshot.revision),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(snapshot.family),
    });
    assert.equal(response.status, 200);
    assert.equal(
      (
        await fetch(base + "/api/family").then((r) => r.json())
      ).family.photos.at(-1).tags.length,
      1,
    );
    response = await fetch(base + "/api/backup", {
      headers: { Cookie: cookie },
    });
    assert.equal(response.status, 200);
    assert.equal(
      Buffer.from(await response.arrayBuffer()).toString("ascii", 0, 15),
      "SQLite format 3",
    );
    response = await fetch(base + "/api/photos", {
      method: "POST",
      headers: { Cookie: cookie, "If-Match": "1", "X-Drevo-Upload": "1" },
      body: "<svg>not a valid image</svg>",
    });
    assert.equal(response.status, 400);
    assert.equal(
      (
        await fetch(base + "/api/logout", {
          method: "POST",
          headers: { Cookie: cookie, Origin: "https://evil.test" },
        })
      ).status,
      403,
    );
    await fetch(base + "/api/logout", {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(
      (await fetch(base + "/api/backup", { headers: { Cookie: cookie } }))
        .status,
      401,
    );
    assert.ok(readFileSync(join(dir, "db.sqlite")).length > 0);
  } finally {
    await app.close();
    delete process.env.PUBLIC_ORIGIN;
    delete process.env.ARCHIVE_PASSWORD_HASH;
    rmSync(dir, { recursive: true, force: true });
  }
});
