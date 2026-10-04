import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { archiveConnections, replaceConnection } from "../src/domain/connections.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import { offlineFamily } from "../src/server/offline-package.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { allCitations } from "../src/server/source-catalog-store.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { removeConnection } from "../src/domain/mutations.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { openArchive } from "../src/server/database.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { storeDatabase } from "../src/server/store-database.ts";
import type { ArchiveUser, Family, Person } from "../src/domain/index.ts";

const person = (id: string): Person => ({ id, name: id, surname: "Test",
  patronymic: "", sex: "u", birth: "", birthPlace: "", parents: [], spouses: [],
  generation: 1, column: 0, sources: [], createdBy: "editor" });
const citation = { title: "Birth register", type: "book", reference: "p. 4" };
const family = (): Family => {
  const father = person("father"), mother = person("mother"), child = person("child");
  child.parents = [father.id, mother.id];
  Object.assign(child, { parentClaims: [{ parentId: father.id, sources: [citation],
    confidence: "probable" }] });
  return { title: "Family", description: "", demo: false, people: [father, mother, child] };
};

test("parent evidence annotates only an existing direct edge and survives SQLite relation rows", async () => {
  const data = family();
  assert.equal((validateFamily(data).people[2] as Person & { parentClaims: unknown[] })
    .parentClaims.length, 1);
  assert.deepEqual(archiveConnections(data).find((edge) => edge.type === "parent" &&
    edge.from === "father")?.sources, [citation]);
  const changed = structuredClone(data);
  changed.people[2].parents = ["mother"];
  assert.throws(() => validateFamily(changed), /родител/i);
  const dir = await mkdtemp(join(tmpdir(), "drevo-parent-evidence-"));
  const archive = await openArchive(join(dir, "archive.sqlite"), family());
  try {
    const restored = (await archive.read()).family;
    const edge = archiveConnections(restored).find((item) => item.type === "parent" &&
      item.from === "father")!;
    assert.equal(edge.confidence, "probable");
    const row = await archive.db.prepare("SELECT sources,confidence FROM relations WHERE id=?",
      "SELECT sources,confidence FROM relations WHERE id=?")
      .get("parent:father:child");
    assert.deepEqual(JSON.parse(String(row?.sources)), [citation]);
    assert.equal(row?.confidence, "probable");
    const unsupported = new DatabaseSync(join(dir, "archive.sqlite"));
    try {
      assert.doesNotThrow(() => unsupported.prepare("UPDATE relations SET note=note WHERE id=?")
        .run("parent:father:child"));
      assert.equal(unsupported.prepare("SELECT count(*) AS count FROM relations").get()?.count, 2);
      assert.throws(() => unsupported.prepare("UPDATE relations SET sources='[]',confidence=NULL WHERE id=?")
        .run("parent:father:child"), /drevo_parent_evidence_writer|Unsupported writer/);
      assert.throws(() => unsupported.prepare("DELETE FROM relations WHERE id=?")
        .run("parent:father:child"), /drevo_parent_evidence_writer|Unsupported writer/);
    } finally { unsupported.close(); }
    assert.equal((await archive.read()).family.people[2].parentClaims?.[0].confidence, "probable");
    const same = replaceConnection(restored, edge, { ...edge, confidence: "confirmed" });
    assert.equal(archiveConnections(same).find((item) => item.key === edge.key)?.confidence,
      "confirmed");
    await archive.write(same, (await archive.read()).revision);
    assert.equal((await archive.read()).family.people[2].parentClaims?.[0].confidence,
      "confirmed");
    await archive.patchPeople([{ collection: "people", id: "child", field: "surname",
      before: "Test", after: "Changed" }], (await archive.read()).revision,
    { id: "editor", name: "Editor", role: "admin", approved: true, createdAt: "2026-01-01" });
    assert.equal((await archive.read()).family.people[2].parentClaims?.[0].confidence,
      "confirmed", "the SQLite card-only fast path retains relation evidence");
  } finally {
    await archive.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("scoped projection never reveals evidence for a hidden parent", () => {
  const data = family();
  data.people.push(person("outsider"));
  const user = { id: "editor", name: "Editor", role: "researcher",
    createdAt: "2026-01-01", treeAccess: "common_ancestors", personId: "outsider" } as ArchiveUser;
  // A self-created child is visible, but their other creator's parents are not.
  data.people[0].createdBy = "other";
  data.people[1].createdBy = "other";
  const scoped = projectFamilyForUser(data, user);
  assert.deepEqual(scoped.people.find((item) => item.id === "child")?.parents, []);
  assert.deepEqual(scoped.people.find((item) => item.id === "child")?.parentClaims, []);
  assert.equal(allCitations(scoped).some((source) => source.title === citation.title), false);
  const share = sharedFamily(data, { id: "share", title: "Branch", anchorId: "child",
    personIds: ["child"], createdAt: "", expiresAt: "", createdBy: "editor",
    createdName: "Editor", revokedAt: null, lastVisitedAt: null }, "token");
  assert.deepEqual(share.people[0].parentClaims, []);
  assert.equal(allCitations(share).length, 0);
  const branch = offlineFamily(data, "family", "child", 0);
  for (const child of branch.people)
    for (const claim of child.parentClaims || [])
      assert.ok(child.parents.includes(claim.parentId));
});

test("GEDCOM 5.5.1 and 7 preserve direct-edge citations only through a warned Drevo extension", () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    const text = exportGedcom(family(), { version });
    assert.match(text, /1 _DREVO_PARENT_CLAIM @I1@/);
    assert.match(text, /2 _DREVO_PARENT_CONFIDENCE probable/);
    assert.doesNotMatch(text, /2 SOUR .*\n3 _DREVO_PARENT_CLAIM/);
    const imported = importGedcom(text, "parent-test");
    const child = imported.family.people.find((item) => item.name === "child")!;
    assert.equal(child.parentClaims?.[0].confidence, "probable");
    assert.equal(child.parentClaims?.[0].sources?.[0].title, citation.title);
    assert.ok(imported.warnings.some((warning) => warning.includes("расширение Drevo")));
  }
});

test("SQLite upgrades an old confidence CHECK without changing relation IDs, sources or other constraints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drevo-parent-schema-"));
  const path = join(dir, "old.sqlite");
  const oldFamily = family();
  delete oldFamily.people[2].parentClaims;
  oldFamily.links = [{ id: "guardian", from: "father", to: "child",
    type: "guardian", sources: [citation], confidence: "confirmed" }];
  const archive = await openArchive(path, oldFamily);
  await archive.close();
  const db = new DatabaseSync(path);
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE relations_legacy (
        id TEXT PRIMARY KEY, source TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        target TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('parent','spouse','adoptive_parent','foster_parent','presumed_parent','step_parent','godparent','nurse','sworn_sibling','guardian','twin')),
        note TEXT NOT NULL DEFAULT '',
        twin_kind TEXT CHECK(twin_kind IS NULL OR (type='twin' AND twin_kind IN ('identical','fraternal','unknown'))),
        created_by TEXT,
        sources TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(sources) AND json_type(sources)='array'),
        confidence TEXT CHECK(confidence IS NULL OR (type NOT IN ('parent','spouse') AND confidence IN ('confirmed','probable','tentative','conflicting','unknown'))),
        CHECK(source<>target), UNIQUE(source,target,type)
      ) STRICT;
      INSERT INTO relations_legacy SELECT * FROM relations;
      DROP TABLE relations;
      ALTER TABLE relations_legacy RENAME TO relations;
      CREATE INDEX relations_target ON relations(target);
      DELETE FROM migrations WHERE id='2026-10-parent-confidence';
      COMMIT;`);
    db.exec("ALTER TABLE relations ADD COLUMN unexpected TEXT DEFAULT 'retain'");
    assert.throws(() => initializeArchiveSchema(db),
      /Unexpected relations schema before parent confidence migration/);
    assert.equal(db.prepare("SELECT unexpected FROM relations WHERE id='parent:father:child'")
      .get()?.unexpected, "retain", "unknown data is not silently discarded");
    db.exec("ALTER TABLE relations DROP COLUMN unexpected");
    initializeArchiveSchema(db);
    assert.equal(db.prepare("SELECT confidence FROM relations WHERE id='guardian'").get()?.confidence,
      "confirmed");
    assert.equal(db.prepare("SELECT id FROM relations WHERE id='parent:father:child'").get()?.id,
      "parent:father:child");
    assert.deepEqual(JSON.parse(String(db.prepare("SELECT sources FROM relations WHERE id='guardian'")
      .get()?.sources)), [citation]);
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    const legacy = new DatabaseSync(path);
    try {
      assert.doesNotThrow(() => legacy.prepare("UPDATE relations SET note='ordinary' WHERE id='guardian'").run());
      assert.doesNotThrow(() => legacy.prepare("UPDATE relations SET note='ordinary' WHERE id='parent:father:child'").run());
    } finally { legacy.close(); }
    storeDatabase(db);
    db.prepare("UPDATE relations SET confidence='probable' WHERE id='parent:father:child'").run();
    const unsupported = new DatabaseSync(path);
    try {
      assert.throws(() => unsupported.prepare("UPDATE relations SET confidence=NULL WHERE id='parent:father:child'")
        .run(), /Unsupported writer for parent evidence/);
    } finally { unsupported.close(); }
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

test("server preserves omitted metadata from old clients and enforces assessment/catalog roles", () => {
  const before = family();
  const actor = (role: ArchiveUser["role"]): ArchiveUser => ({ id: "editor", name: "Editor",
    role, createdAt: "2026-01-01" });
  const oldClient = structuredClone(before);
  delete oldClient.people[2].parentClaims;
  oldClient.people[2].surname = "Changed";
  const preserved = authorizeArchive(oldClient, before, actor("relative"));
  assert.equal(preserved.people[2].parentClaims?.[0].confidence, "probable");
  assert.equal(before.people[2].surname, "Test", "authorization does not mutate current state");
  oldClient.people[2].parents = ["mother"];
  assert.throws(() => authorizeArchive(oldClient, before, actor("admin")), /Обновите страницу/);
  const changed = structuredClone(before);
  changed.people[2].parentClaims![0].confidence = "confirmed";
  assert.throws(() => authorizeArchive(changed, before, actor("relative")), /Статус достоверности/);
  assert.equal(authorizeArchive(changed, before, actor("researcher"))
    .people[2].parentClaims?.[0].confidence, "confirmed");
  const catalog = structuredClone(before);
  catalog.people[2].parentClaims![0].sources!.push({ ...citation, catalogId: "local-source" });
  assert.throws(() => authorizeArchive(catalog, before, actor("researcher")), /каталожный источник/);
  assert.equal(authorizeArchive(catalog, before, actor("admin"))
    .people[2].parentClaims?.[0].sources?.length, 2);
  const edge = archiveConnections(before).find((item) => item.type === "parent" &&
    item.from === "father")!;
  const removed = removeConnection(before, edge);
  assert.deepEqual(removed.people[2].parentClaims, []);
  assert.throws(() => authorizeArchive(removed, before, actor("relative")), /Оценённую связь/);
  assert.doesNotThrow(() => authorizeArchive(removed, before, actor("admin")));
});
