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
  archiveConnections,
  replaceConnection,
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
test("explicit archive selection cannot silently reuse a SQLite archive", async () => {
  await assert.rejects(
    openArchive(":memory:", seed(), "other-archive"),
    /только PostgreSQL/,
  );
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
test("spouse links infer an unknown sex from the known partner", () => {
  let data = seed();
  data.people.find((p) => p.id === "other")!.sex = "u";
  data = connectPeople(data, "father", "other", "spouse");
  assert.equal(data.people.find((p) => p.id === "other")!.sex, "f");

  data = seed();
  data.people.find((p) => p.id === "child")!.sex = "u";
  data = connectPeople(data, "mother", "child", "spouse");
  assert.equal(data.people.find((p) => p.id === "child")!.sex, "m");
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
    "усыновитель",
  );
  assert.deepEqual(f.people[2].parents, []);
  assert.throws(() => connectPeople(f, "child", "father", "adoptive_parent"));
  f = connectPeople(f, "child", "other", "sworn_sibling");
  assert.throws(() => connectPeople(f, "other", "child", "sworn_sibling"));
});
test("twins require an explicit symmetric record and retain their recorded type", () => {
  let family = seed();
  family.people[3].birth = "1980";
  assert.equal(
    analyzeKinship(
      family.people[2],
      family.people[3],
      family.people,
      family.links,
    ).kind,
    "unknown",
  );
  family = connectPeople(family, "child", "other", "twin", "", "unknown");
  assert.equal(family.links?.[0].twinKind, "unknown");
  assert.deepEqual(family.people[2].parents, []);
  assert.throws(
    () => connectPeople(family, "other", "child", "twin"),
    /уже существует/,
  );
  const edge = archiveConnections(family).find((item) => item.type === "twin")!;
  family = replaceConnection(family, edge, {
    from: "other",
    to: "child",
    type: "twin",
    twinKind: "fraternal",
  });
  assert.equal(family.links?.[0].twinKind, "fraternal");
  assert.equal(family.links?.[0].id, edge.id);
  assert.match(
    analyzeKinship(
      family.people[2],
      family.people[3],
      family.people,
      family.links,
    ).explanation,
    /близнец/i,
  );
  assert.throws(() =>
    validateFamily({
      ...family,
      links: [{ ...family.links![0], twinKind: "guess" }],
    }),
  );
  const parentAndChild = connectPeople(seed(), "father", "child", "parent");
  assert.throws(
    () => connectPeople(parentAndChild, "father", "child", "twin"),
    /не могут быть близнецами/,
  );
});
test("SQLite preserves twin type and distinct foster and presumed parents after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-parentage-"));
  const path = join(dir, "archive.sqlite");
  let store = await openArchive(path, seed());
  try {
    const initial = await store.read();
    const family = structuredClone(initial.family);
    family.people[3].birth = "1980";
    let next = connectPeople(family, "child", "other", "twin", "", "fraternal");
    next = connectPeople(next, "father", "child", "foster_parent");
    next = connectPeople(next, "mother", "child", "presumed_parent", "Требует проверки");
    const saved = await store.write(next, initial.revision);
    assert.equal(saved.family.links?.find((link) => link.type === "twin")?.twinKind, "fraternal");
    await store.close();
    store = await openArchive(path, seed());
    assert.deepEqual((await store.read()).family.links, saved.family.links);
    assert.deepEqual((await store.read()).family.people[2].parents, []);
  } finally {
    await store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("presumed parentage is shown as a hypothesis and does not establish an indirect family path", () => {
  let family = connectPeople(seed(), "mother", "child", "presumed_parent", "Требует подтверждения");
  family = connectPeople(family, "father", "child", "foster_parent");
  const [father, mother, child] = family.people;
  const direct = analyzeKinship(mother, child, family.people, family.links);
  assert.equal(direct.kind, "unknown");
  assert.equal(direct.roles?.[0].term, "предполагаемая мать");
  assert.equal(analyzeKinship(mother, father, family.people, family.links).kind, "unknown");
});

test("explicit step-parent works with incomplete ancestry and never becomes a blood parent", () => {
  let f = connectPeople(seed(), "father", "child", "step_parent");
  const role = (a: string, b: string) =>
    analyzeKinship(
      f.people.find((p) => p.id === a)!,
      f.people.find((p) => p.id === b)!,
      f.people,
      f.links,
    ).roles?.[0].term;
  assert.equal(role("father", "child"), "отчим");
  assert.equal(role("child", "father"), "пасынок");
  assert.deepEqual(f.people.find((p) => p.id === "child")!.parents, []);
  f = connectPeople(f, "mother", "other", "step_parent");
  assert.equal(role("mother", "other"), "мачеха");
  assert.equal(role("other", "mother"), "падчерица");
  assert.throws(() => connectPeople(f, "father", "child", "step_parent"));
  assert.throws(() => connectPeople(f, "child", "father", "step_parent"));
  assert.throws(() => connectPeople(f, "child", "father", "parent"));
});
test("SQLite persists graph and photo tags, rejects stale writes, makes readable standalone backup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-test-")),
    path = join(dir, "archive.sqlite"),
    uploads = join(dir, "uploads"),
    photoFile = join(uploads, "photo.png");
  let store = await openArchive(path, seed());
  try {
    mkdirSync(uploads, { recursive: true });
    writeFileSync(photoFile, "test image placeholder");
    const first = await store.read();
    const family = connectPeople(
      connectPeople(first.family, "father", "child", "parent"),
      "mother",
      "child",
      "step_parent",
    );
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
    const saved = await store.write(family, first.revision);
    assert.equal(saved.family.links?.[0].type, "step_parent");
    assert.equal(existsSync(photoFile), true);
    await assert.rejects(
      async () => await store.write(first.family, first.revision),
      ConflictError,
    );
    assert.equal((await store.read()).revision, saved.revision);
    const invalid = structuredClone(saved.family);
    invalid.photos![0].tags[0].width = 2;
    await assert.rejects(
      async () => await store.write(invalid, saved.revision),
    );
    assert.deepEqual(await store.read(), saved);
    const backup = join(dir, "backup.sqlite");
    await writeDatabaseBackup(store.db, backup);
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
    await store.close();
    store = await openArchive(path, seed());
    assert.deepEqual(await store.read(), saved);
    assert.equal(
      existsSync(photoFile),
      true,
      "referenced media survives restart",
    );
    const removed = removePerson(saved.family, "child");
    assert.equal(removed.photos![0].tags.length, 0);
    await store.write({ ...seed(), people: [] }, saved.revision, {
      id: "admin",
      name: "Администратор",
      role: "admin",
      createdAt: "",
    });
    assert.equal(
      existsSync(photoFile),
      true,
      "dropped media remains available to history and backup restoration",
    );
    await store.close();
    store = await openArchive(path, seed());
    assert.equal((await store.read()).family.people.length, 0);
  } finally {
    await store.close();
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
