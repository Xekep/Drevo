import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../src/server/database.ts";
import { ARCHIVE_SCHEMA_VERSION } from "../src/server/schema.ts";
import { importGedcom, exportGedcom } from "../src/domain/gedcom.ts";
import {
  analyzeKinship,
  unionStatus,
  validateFamily,
  type Family,
  type FamilyUnion,
  type Person,
} from "../src/domain/index.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import {
  archiveChanges,
  applyArchiveChanges,
  inverseChanges,
} from "../src/domain/changes.ts";

const person = (id: string): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex: "u",
  birth: "1900",
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
});
const family = (): Family => {
  const a = person("a"),
    b = person("b"),
    c = person("c");
  a.spouses = ["b", "c"];
  b.spouses = ["a"];
  c.spouses = ["a"];
  a.events = [{ id: "old-divorce", type: "divorce", date: "1940" }];
  return { title: "Тест", description: "", demo: false, people: [a, b, c] };
};
const source = { title: "Акт", type: "archive", reference: "лист 3" };
const unions = (): FamilyUnion[] => [
  {
    id: "first",
    participants: ["a", "b"],
    type: "marriage",
    formation: {
      dateText: "около 1920 года",
      place: "Москва",
      sources: [source],
    },
    divorce: { date: "1940", place: "Москва" },
    sources: [source],
  },
  {
    id: "second",
    participants: ["a", "b"],
    type: "marriage",
    formation: { date: "1950" },
    ongoing: { date: new Date().toISOString().slice(0, 10), sources: [source] },
  },
];

test("status is derived per union, never from a person's ambiguous divorce event", () => {
  const data = family();
  assert.equal(
    analyzeKinship(data.people[0], data.people[1], data.people, [], data.unions)
      .title,
    "Супруги и партнёры",
  );
  assert.equal(
    analyzeKinship(data.people[0], data.people[2], data.people, [], data.unions)
      .title,
    "Супруги и партнёры",
  );
  data.unions = unions();
  assert.equal(unionStatus(data.unions[0], "2026-01-01"), "former");
  assert.equal(unionStatus(data.unions[1], "1960-01-01"), "unknown");
  assert.equal(unionStatus(data.unions[1]), "current");
  assert.equal(
    analyzeKinship(data.people[0], data.people[1], data.people, [], data.unions)
      .title,
    "Супруги",
  );
  assert.equal(
    analyzeKinship(data.people[0], data.people[2], data.people, [], data.unions)
      .title,
    "Супруги и партнёры",
  );
  data.unions = [unions()[0]];
  assert.equal(
    analyzeKinship(data.people[0], data.people[1], data.people, [], data.unions)
      .roles?.[0].term,
    "бывший супруг / супруга",
  );
});

test("SQLite migration and revisions preserve multiple unions of one pair", async () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-unions-"));
  const path = join(dir, "archive.sqlite");
  try {
    const original = family();
    let store = await openArchive(path, original);
    const before = await store.read();
    assert.equal(before.family.unions, undefined);
    const saved = await store.write(
      { ...before.family, unions: unions() },
      before.revision,
    );
    assert.equal(saved.family.unions?.length, 2);
    assert.equal((await store.readRevision(before.revision)).unions, undefined);
    await store.close();
    const db = new DatabaseSync(path);
    assert.equal(
      db.prepare("PRAGMA user_version").get()!.user_version,
      ARCHIVE_SCHEMA_VERSION,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM family_unions").get()!.n,
      2,
    );
    db.close();
    store = await openArchive(path, original);
    const reread = await store.read();
    assert.deepEqual(reread.family.unions, unions());
    await store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GEDCOM 5.5.1 and 7 retain separate unions and uncertain dates", () => {
  const data = { ...family(), unions: unions() };
  for (const version of ["5.5.1", "7.0"] as const) {
    const text = exportGedcom(data, { version });
    assert.match(text, /_DREVO_UNION/);
    const imported = importGedcom(text, `unions-${version}`).family;
    assert.equal(imported.unions?.length, 2);
    assert.equal(imported.unions?.[0].formation?.dateText, "около 1920 года");
    assert.equal(imported.unions?.[0].formation?.sources?.[0].title, "Акт");
    assert.equal(
      imported.unions?.[1].ongoing?.date,
      data.unions[1].ongoing?.date,
    );
    const legacy = exportGedcom(family(), { version });
    assert.doesNotMatch(legacy, /1 MARR Y/);
    assert.match(legacy, /_DREVO_SPOUSE Y/);
  }
});

test("union validation and scoped projections protect participants", () => {
  const data = { ...family(), unions: unions() };
  assert.throws(
    () =>
      validateFamily({
        ...data,
        unions: [{ ...unions()[0], participants: ["a", "missing"] }],
      }),
    /союз/,
  );
  const projected = projectFamilyForUser(data, {
    id: "other",
    name: "Other",
    role: "relative",
    createdAt: "2020-01-01",
    treeAccess: "common_ancestors",
    personId: "c",
  });
  assert.equal(projected.unions?.length, 0);
});

test("union edits participate in revision changes and undo", () => {
  const before = family();
  const after = { ...before, unions: unions() };
  const changes = archiveChanges(before, after);
  assert.equal(
    changes.filter((change) => change.collection === "unions").length,
    2,
  );
  assert.deepEqual(
    applyArchiveChanges(before, changes).family.unions,
    after.unions,
  );
  assert.deepEqual(
    applyArchiveChanges(after, inverseChanges(changes)).family.unions,
    [],
  );
});
