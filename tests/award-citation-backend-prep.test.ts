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

test("release A preserves omitted award citations on independent writes without mutating input", () => {
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

test("release A refuses every award citation delta, including removal and identity transfer", () => {
  const current = withCitation();
  const denied = (next: Family) => {
    assert.throws(() => authorizeArchive(next, current, actor),
      /Цитаты наград пока доступны только для чтения|Обновите страницу/);
    assert.throws(() => prepareAwardCitationWrite(structuredClone(next), current),
      /Цитаты наград пока доступны только для чтения|Обновите страницу/);
  };
  const changed = structuredClone(current);
  changed.people[0].awards![0].sources![0].reference = "л. 3";
  denied(changed);
  const removed = structuredClone(current);
  removed.people[0].awards![0].sources = [];
  denied(removed);
  const newIdentity = structuredClone(current);
  newIdentity.people[0].awards![0].name = "Другая медаль";
  denied(newIdentity);
  const omittedMoved = structuredClone(newIdentity);
  delete omittedMoved.people[0].awards![0].sources;
  denied(omittedMoved);
  const removedAward = structuredClone(current);
  removedAward.people[0].awards = [];
  denied(removedAward);
  const removedPerson = structuredClone(current);
  removedPerson.people = [];
  denied(removedPerson);
  const added = withCitation();
  added.people[0].awards![0].sources![0].catalogId = "foreign-catalog";
  assert.throws(() => authorizeArchive(added, family(), actor),
    /Цитаты наград пока доступны только для чтения/);
  assert.throws(() => prepareAwardCitationWrite(structuredClone(added), null),
    /Цитаты наград пока доступны только для чтения/);
});

test("SQLite startup reads preexisting citations; unchanged write works and new refs fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "award-prep-"));
  const archive = await openArchive(join(root, "archive.sqlite"), family());
  try {
    const record = { id: "award-record", title: "Наградной лист", type: "архив",
      author: "", institution: "", archive: "", fond: "", opis: "", delo: "",
      sheet: "", reference: "л. 2", url: "", accessedAt: "", description: "",
      documentIds: [] };
    await sourceCatalogStore(archive.db).insert(record);
    // Synthetic row represents a database written after activation then read
    // by the previous backend. The public writer must never seed this field.
    const seeded = withCitation();
    await archive.db.prepare("UPDATE people SET data=? WHERE id=?")
      .run(JSON.stringify({ ...seeded.people[0], parents: undefined, spouses: undefined }), "person");
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
      /Цитаты наград пока доступны только для чтения/);
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
