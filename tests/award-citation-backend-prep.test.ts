import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Family, Source } from "../src/domain/types.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { prepareAwardCitationWrite } from "../src/server/award-citation-write.ts";
import { openArchive } from "../src/server/database.ts";
import { allCitations, sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import { archiveOverview } from "../src/domain/archive-projection.ts";

const source: Source = { title: "Наградной лист", type: "архив", reference: "л. 2",
  catalogId: "award-record" };
const family = (): Family => ({ title: "Награды", description: "", demo: false,
  people: [{ id: "person", name: "Иван", surname: "Примеров", patronymic: "",
    sex: "m", birth: "", birthPlace: "", parents: [], spouses: [],
    generation: 1, column: 0, createdBy: "owner", sources: [],
    awards: [{ id: "award", name: "Медаль", year: "1945" }] }] });
const actor = { id: "owner", name: "Владелец", role: "admin" as const,
  approved: true, createdAt: "2026-01-01" };
const withCitation = () => {
  const data = family();
  data.people[0].awards![0].sources = [structuredClone(source)];
  return data;
};

test("award citations survive omitted old-client fields on independent writes", () => {
  const current = withCitation();
  const oldClient = family();
  oldClient.people[0].surname = "Уточнён";
  const authorized = authorizeArchive(oldClient, current, actor);
  assert.deepEqual(authorized.people[0].awards?.[0].sources, [source]);
  assert.equal(oldClient.people[0].awards?.[0].sources, undefined);
  assert.equal(current.people[0].surname, "Примеров");
  assert.deepEqual(prepareAwardCitationWrite(structuredClone(oldClient), current)
    .people[0].awards?.[0].sources, [source], "trusted write uses the same guard");
  assert.equal(allCitations(authorized).length, 1);
  assert.equal(archiveOverview(authorized).people[0].awards, undefined);
});

test("award citations allow explicit edits and deletion but never silently move with identity", () => {
  const current = withCitation();
  const changed = structuredClone(current);
  changed.people[0].awards![0].sources![0].reference = "л. 3";
  assert.equal(authorizeArchive(changed, current, actor).people[0].awards?.[0].sources?.[0].reference, "л. 3");
  const removed = structuredClone(current);
  removed.people[0].awards![0].sources = [];
  assert.deepEqual(authorizeArchive(removed, current, actor).people[0].awards?.[0].sources, []);
  const newIdentity = structuredClone(current);
  newIdentity.people[0].awards![0].name = "Другая медаль";
  assert.equal(authorizeArchive(newIdentity, current, actor).people[0].awards?.[0].name, "Другая медаль",
    "explicitly retained citations require deliberate client choice");
  const omittedMoved = structuredClone(newIdentity);
  delete omittedMoved.people[0].awards![0].sources;
  assert.throws(() => authorizeArchive(omittedMoved, current, actor), /Обновите страницу/);
  assert.throws(() => prepareAwardCitationWrite(structuredClone(omittedMoved), current), /Обновите страницу/);
  const changedDegree = structuredClone(current);
  changedDegree.people[0].awards![0].degreeId = "second";
  delete changedDegree.people[0].awards![0].sources;
  assert.throws(() => authorizeArchive(changedDegree, current, actor), /Обновите страницу/);
  const removedAward = structuredClone(current);
  removedAward.people[0].awards = [];
  assert.deepEqual(authorizeArchive(removedAward, current, actor).people[0].awards, []);
  const removedPerson = structuredClone(current);
  removedPerson.people = [];
  assert.deepEqual(prepareAwardCitationWrite(removedPerson, current).people, []);
  // Catalog existence is checked by the database-backed writer, not this pure guard.
});

test("a relative may edit their own inline award citation but cannot add a catalog citation", () => {
  const current = family();
  current.people[0].createdBy = "relative";
  const relative = { ...actor, id: "relative", role: "relative" as const };
  const inline = structuredClone(current);
  inline.people[0].awards![0].sources = [{ title: "Местная запись", type: "архив",
    reference: "л. 2" }];
  assert.equal(authorizeArchive(inline, current, relative).people[0].awards?.[0]
    .sources?.[0].reference, "л. 2");
  const catalog = structuredClone(inline);
  catalog.people[0].awards![0].sources!.push(structuredClone(source));
  assert.throws(() => authorizeArchive(catalog, current, relative),
    /Привязать каталожный источник может только администратор/);
});

test("SQLite accepts valid award citations, preserves old-client fields and rejects foreign catalog refs", async () => {
  const root = await mkdtemp(join(tmpdir(), "award-prep-"));
  const archive = await openArchive(join(root, "archive.sqlite"), family());
  try {
    const record = { id: "award-record", title: "Наградной лист", type: "архив",
      author: "", institution: "", archive: "", fond: "", opis: "", delo: "",
      sheet: "", reference: "л. 2", url: "", accessedAt: "", description: "",
      documentIds: [] };
    await sourceCatalogStore(archive.db).insert(record);
    const initial = await archive.read();
    await archive.write(withCitation(), initial.revision);
    const before = await archive.read();
    assert.deepEqual(before.family.people[0].awards?.[0].sources?.[0].catalogId,
      "award-record");
    const oldClient = structuredClone(before.family);
    delete oldClient.people[0].awards![0].sources;
    oldClient.people[0].surname = "Уточнён";
    const saved = await archive.write(oldClient, before.revision);
    assert.equal(saved.revision, before.revision + 1);
    assert.deepEqual((await archive.read()).family.people[0].awards?.[0].sources,
      [source]);
    const next = structuredClone((await archive.read()).family);
    next.people[0].awards![0].sources![0].catalogId = "foreign-catalog";
    await assert.rejects(archive.write(next, saved.revision),
      /Источник отсутствует|каталожный/i);
    assert.equal((await archive.read()).revision, saved.revision);
    const patch = await archive.patchPeople([{ collection: "people", id: "person",
      field: "awards", before: next.people[0].awards,
      after: [] }], saved.revision, actor);
    assert.equal(patch, null, "award changes use the full archive writer");
  } finally {
    await archive.close();
    await rm(root, { recursive: true, force: true });
  }
});
