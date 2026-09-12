import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openArchive, ConflictError } from "../src/server/database.ts";
import { writeDatabaseBackup } from "../src/server/backup.ts";
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
    path = join(dir, "archive.sqlite"),
    uploads = join(dir, "uploads"),
    photoFile = join(uploads, "photo.png");
  let store = openArchive(path, seed());
  try {
    mkdirSync(uploads, { recursive: true });
    writeFileSync(photoFile, "test image placeholder");
    const first = store.read();
    const family = connectPeople(first.family, "father", "child", "parent");
    family.photos = [
      {
        id: "photo",
        url: "/media/photo.png",
        title: "Снимок",
        place: "Кострома",
        year: "1965",
        event: "Семейная встреча",
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
    assert.equal(existsSync(photoFile), true);
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
    writeDatabaseBackup(store.db, backup);
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
    assert.equal(existsSync(photoFile), true, "referenced media survives restart");
    const removed = removePerson(saved.family, "child");
    assert.equal(removed.photos![0].tags.length, 0);
    store.write(
      { ...seed(), people: [] },
      saved.revision,
      { id: "admin", name: "Администратор", role: "admin", createdAt: "" },
    );
    assert.equal(
      existsSync(photoFile),
      true,
      "dropped media remains available to history and backup restoration",
    );
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
