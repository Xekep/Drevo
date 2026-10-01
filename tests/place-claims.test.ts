import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../src/server/database.ts";
import { startServer } from "../src/server/index.ts";
import { archiveChanges } from "../src/domain/changes.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { sourceCatalogStore, allCitations } from "../src/server/source-catalog-store.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";

const source = (id: string, title: string): CatalogSource => ({
  id, title, type: "архивная запись", author: "", institution: "", archive: "ГАСО",
  fond: "6", opis: "13", delo: "104", sheet: "7", reference: "л. 7", url: "",
  accessedAt: "", description: "", documentIds: [],
});
const birthSource = source("birth-place-record", "Запись о Туле");
const deathSource = source("death-place-record", "Запись о Казани");
const family = (): Family => ({
  title: "Родословная", description: "", demo: false,
  people: [{ id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
    sex: "f", birth: "1880", death: "1950", birthPlace: "Тула", deathPlace: "Казань",
    parents: [], spouses: [], generation: 1, column: 0, sources: [], createdBy: "admin" }],
});
function citePlaces(next: Family) {
  next.people[0].birthPlaceClaim = { value: "Тула", sources: [sourceCitation(birthSource)] };
  next.people[0].deathPlaceClaim = { value: "Казань", sources: [sourceCitation(deathSource)] };
}

test("place citations bind to exact labels, reject foreign catalog links and protect their sources", async () => {
  const archive = await openArchive(":memory:", family());
  try {
    await sourceCatalogStore(archive.db).insert(birthSource);
    await sourceCatalogStore(archive.db).insert(deathSource);
    const next = (await archive.read()).family;
    citePlaces(next);
    await archive.write(next, (await archive.read()).revision);
    const stored = (await archive.read()).family;
    assert.deepEqual(allCitations(stored).map((citation) => citation.catalogId),
      [birthSource.id, deathSource.id]);
    for (const key of ["birthPlace", "deathPlace"] as const) {
      const changed = structuredClone(stored);
      changed.people[0][key] = "Другое место";
      assert.throws(() => validateFamily(changed), /Источник места/);
      await assert.rejects(archive.write(changed, (await archive.read()).revision), /Источник места/);
    }
    const removed = structuredClone(stored);
    removed.people[0].deathPlace = undefined;
    assert.throws(() => validateFamily(removed), /Источник места смерти/);
    const foreign = structuredClone(stored);
    foreign.people[0].birthPlaceClaim!.sources[0].catalogId = "another-archive";
    await assert.rejects(archive.write(foreign, (await archive.read()).revision), /Источник отсутствует/);
    const empty = structuredClone(stored);
    empty.people[0].birthPlaceClaim!.sources = [{ title: "", type: "", reference: "" }];
    assert.throws(() => validateFamily(empty), /Источник места рождения/);

    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...birthSource, title: "Исправленная Тула" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    assert.equal((await archive.read()).family.people[0].birthPlaceClaim?.sources[0].title,
      "Исправленная Тула");
    const coordinates = (await archive.read()).family;
    coordinates.people[0].birthLocation = { place: "Тула", lat: 54.2, lon: 37.6 };
    await archive.write(coordinates, (await archive.read()).revision);
    assert.equal((await archive.read()).family.people[0].birthPlaceClaim?.value, "Тула");
  } finally {
    await archive.close();
  }
});

test(".drevo and GEDCOM 5.5.1/7 keep distinct birth and death place citations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-place-claims-"));
  const archive = await openArchive(":memory:", family());
  try {
    await sourceCatalogStore(archive.db).insert(birthSource);
    await sourceCatalogStore(archive.db).insert(deathSource);
    const next = (await archive.read()).family;
    citePlaces(next);
    await archive.write(next, (await archive.read()).revision);
    const stored = (await archive.read()).family;

    const uploads = join(directory, "uploads");
    const stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const path = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads, {
      family: stored, documents: [], comments: [], sources: [birthSource, deathSource],
    }, async () => {});
    const portable = await readPortablePackage(path, stage);
    const portablePerson = portable.snapshot.family.people[0];
    assert.equal(portablePerson.birthPlaceClaim?.sources[0].catalogId, birthSource.id);
    assert.equal(portablePerson.deathPlaceClaim?.sources[0].catalogId, deathSource.id);

    for (const version of ["5.5.1", "7.0"] as const) {
      const gedcom = exportGedcom(stored, { version });
      assert.match(gedcom, /1 BIRT Y\r\n2 DATE 1880\r\n2 PLAC Тула\r\n/);
      assert.match(gedcom, /1 DEAT Y\r\n2 DATE 1950\r\n2 PLAC Казань\r\n/);
      assert.match(gedcom, /3 _DREVO_CLAIM BIRTH_PLACE/);
      assert.match(gedcom, /3 _DREVO_CLAIM DEATH_PLACE/);
      const imported = importGedcom(gedcom, `other-${version}`).family.people[0];
      assert.equal(imported.birthPlaceClaim?.value, "Тула");
      assert.equal(imported.birthPlaceClaim?.sources[0].title, birthSource.title);
      assert.equal(imported.deathPlaceClaim?.value, "Казань");
      assert.equal(imported.deathPlaceClaim?.sources[0].title, deathSource.title);
      assert.equal(imported.birthPlaceClaim?.sources[0].catalogId, undefined);
      assert.equal(imported.deathPlaceClaim?.sources[0].catalogId, undefined);
      assert.equal(imported.sources.length, 0);

      const ordinary = importGedcom(gedcom
        .replace("3 _DREVO_CLAIM BIRTH_PLACE\r\n", "")
        .replace("3 _DREVO_CLAIM DEATH_PLACE\r\n", "")
        .replace(/^1 _DREVO .+\r\n/m, ""), `ordinary-${version}`).family.people[0];
      assert.equal(ordinary.birthPlaceClaim, undefined);
      assert.equal(ordinary.deathPlaceClaim, undefined);
      assert.deepEqual(ordinary.sources.map((citation) => citation.title),
        [birthSource.title, deathSource.title]);
      const missingPlace = importGedcom(gedcom
        .replace(/(1 BIRT Y\r\n(?:2 DATE .+\r\n)?)2 PLAC .+\r\n/, "$1")
        .replace(/^1 _DREVO .+\r\n/m, ""), `missing-${version}`).family.people[0];
      assert.equal(missingPlace.birthPlaceClaim, undefined);
      assert.equal(missingPlace.sources[0].title, birthSource.title);
    }

    const detailed = structuredClone(stored);
    detailed.people[0].events = [{ id: "birth-event", gedcomTag: "BIRT", type: "other", date: "1879" },
      { id: "death-event", gedcomTag: "DEAT", type: "other", date: "1949" }];
    const importedDetail = importGedcom(exportGedcom(detailed, { version: "7.0" }), "detail")
      .family.people[0];
    assert.equal(importedDetail.birthPlaceClaim?.value, "Тула");
    assert.equal(importedDetail.deathPlaceClaim?.value, "Казань");
    assert.equal(importedDetail.events?.filter((event) => event.gedcomTag === "BIRT").length, 1);
    assert.equal(importedDetail.events?.filter((event) => event.gedcomTag === "DEAT").length, 1);
  } finally {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a non-owner cannot attach a place citation to another person's card", () => {
  const current = family();
  const next = structuredClone(current);
  citePlaces(next);
  const editor: ArchiveUser = {
    id: "editor", name: "Редактор", role: "researcher", createdAt: "2026-01-01",
  };
  assert.throws(() => authorizeArchive(next, current, editor), /только свои карточки/);
});

test("HTTP changes save place citations, reject changed labels and protect linked catalog entries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-place-http-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const seed = await app.archive.read();
    await app.archive.write(family(), seed.revision);
    await sourceCatalogStore(app.archive.db).insert(birthSource);
    await sourceCatalogStore(app.archive.db).insert(deathSource);
    const before = await (await fetch(`${origin}/api/family`)).json();
    const next = structuredClone(before.family) as Family;
    citePlaces(next);
    const post = (changes: ReturnType<typeof archiveChanges>, revision: number) =>
      fetch(`${origin}/api/family/changes`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "If-Match": String(revision),
      }, body: JSON.stringify({ changes }) });
    assert.equal((await post(archiveChanges(before.family, next), before.revision)).status, 200);
    const saved = await app.archive.read();
    assert.equal(saved.family.people[0].birthPlaceClaim?.sources[0].catalogId, birthSource.id);
    assert.equal(saved.family.people[0].deathPlaceClaim?.sources[0].catalogId, deathSource.id);
    const deleteLinked = await fetch(`${origin}/api/sources/${birthSource.id}`, {
      method: "DELETE", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(deleteLinked.status, 409);
    const changed = structuredClone(saved.family);
    changed.people[0].birthPlace = "Другая Тула";
    assert.equal((await post(archiveChanges(saved.family, changed), saved.revision)).status, 400);
    assert.equal((await app.archive.read()).family.people[0].birthPlace, "Тула");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
