import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "../src/server/database.ts";
import { startServer } from "../src/server/index.ts";
import { archiveChanges } from "../src/domain/changes.ts";
import { sourceCatalogStore, allCitations } from "../src/server/source-catalog-store.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writeGenealogyPackage, prepareGenealogyImport } from "../src/server/genealogy-package.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";

const source: CatalogSource = {
  id: "death-register", title: "Книга смертей", type: "архивная запись",
  author: "", institution: "", archive: "ГАСО", fond: "6", opis: "13",
  delo: "105", sheet: "7", reference: "л. 7", url: "", accessedAt: "",
  description: "", documentIds: [],
};
const family = (): Family => ({
  title: "Родословная", description: "", demo: false,
  people: [{ id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
    sex: "f", birth: "1880", death: "1950-03-02", birthPlace: "Тула",
    parents: [], spouses: [], generation: 1, column: 0, sources: [], createdBy: "admin" }],
});

test("death-date citation stays bound to the value and catalogue within its archive", async () => {
  const archive = await openArchive(":memory:", family());
  try {
    await sourceCatalogStore(archive.db).insert(source);
    const next = (await archive.read()).family;
    next.people[0].deathDateClaim = { value: "1950-03-02", sources: [sourceCitation(source)] };
    await archive.write(next, (await archive.read()).revision);
    const stored = (await archive.read()).family;
    assert.equal(stored.people[0].deathDateClaim?.sources[0].catalogId, source.id);
    assert.equal(allCitations(stored).length, 1);

    for (const changedDate of ["1951-03-02", undefined]) {
      const changed = structuredClone(stored);
      changed.people[0].death = changedDate;
      assert.throws(() => validateFamily(changed), /Источник даты смерти/);
      await assert.rejects(archive.write(changed, (await archive.read()).revision), /Источник даты смерти/);
    }
    const empty = structuredClone(stored);
    empty.people[0].deathDateClaim!.sources = [{ title: "", type: "", reference: "" }];
    assert.throws(() => validateFamily(empty), /Источник даты смерти/);
    const foreign = structuredClone(stored);
    foreign.people[0].deathDateClaim!.sources[0].catalogId = "foreign-source";
    await assert.rejects(archive.write(foreign, (await archive.read()).revision), /Источник отсутствует/);

    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...source, title: "Исправленная запись" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    assert.equal((await archive.read()).family.people[0].deathDateClaim?.sources[0].title,
      "Исправленная запись");
  } finally {
    await archive.close();
  }
});

test("death-date claim survives .drevo, GEDCOM 5.5.1/7 and GEDZIP round trips", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-death-claim-"));
  const archive = await openArchive(":memory:", family());
  try {
    await sourceCatalogStore(archive.db).insert(source);
    const next = (await archive.read()).family;
    next.people[0].deathDateClaim = { value: "1950-03-02", sources: [sourceCitation(source)] };
    await archive.write(next, (await archive.read()).revision);
    const stored = (await archive.read()).family;

    const uploads = join(directory, "uploads");
    const stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const packagePath = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(packagePath), uploads, {
      family: stored, documents: [], comments: [], sources: [source],
    }, async () => {});
    const portable = await readPortablePackage(packagePath, stage);
    assert.equal(portable.snapshot.family.people[0].deathDateClaim?.sources[0].catalogId, source.id);

    for (const version of ["5.5.1", "7.0"] as const) {
      const gedcom = exportGedcom(stored, { version });
      assert.match(gedcom, /1 DEAT Y\r\n2 DATE 2 MAR 1950\r\n/);
      assert.match(gedcom, /3 _DREVO_CLAIM DEATH_DATE/);
      const imported = importGedcom(gedcom, `other-${version}`).family.people[0];
      assert.equal(imported.deathDateClaim?.value, "1950-03-02");
      assert.equal(imported.deathDateClaim?.sources[0].title, "Книга смертей");
      assert.equal(imported.deathDateClaim?.sources[0].catalogId, undefined);
      assert.equal(imported.sources.length, 0);
      const ordinary = importGedcom(gedcom
        .replace("3 _DREVO_CLAIM DEATH_DATE\r\n", "")
        .replace(/^1 _DREVO .+\r\n/m, ""), `ordinary-${version}`).family.people[0];
      assert.equal(ordinary.deathDateClaim, undefined);
      assert.equal(ordinary.sources[0].title, "Книга смертей");
      const missingDate = importGedcom(gedcom
        .replace(/(1 DEAT Y\r\n)2 DATE .+\r\n/, "$1")
        .replace(/^1 _DREVO .+\r\n/m, ""), `missing-${version}`).family.people[0];
      assert.equal(missingDate.deathDateClaim, undefined);
      assert.equal(missingDate.sources[0].title, "Книга смертей");
    }
    const withImportedEvent = structuredClone(stored);
    withImportedEvent.people[0].events = [{ id: "death-event", gedcomTag: "DEAT",
      type: "other", date: "1949", title: "Уход из жизни" }];
    const eventRoundTrip = importGedcom(exportGedcom(withImportedEvent, { version: "7.0" }),
      "event-round-trip").family.people[0];
    assert.equal(eventRoundTrip.death, "1950-03-02");
    assert.equal(eventRoundTrip.deathDateClaim?.value, "1950-03-02");
    assert.equal(eventRoundTrip.events?.filter((event) => event.gedcomTag === "DEAT").length, 1);

    const gedzipPath = join(directory, "family.gdz");
    await writeGenealogyPackage(gedzipPath, uploads, stored, []);
    const gedzipStage = join(directory, "gedzip-stage");
    await mkdir(gedzipStage);
    const zipped = await prepareGenealogyImport(gedzipPath, gedzipStage, "zipped");
    assert.equal(zipped.family.people[0].deathDateClaim?.value, "1950-03-02");
    assert.equal(zipped.family.people[0].deathDateClaim?.sources[0].title, "Книга смертей");
    assert.equal(zipped.family.people[0].deathDateClaim?.sources[0].catalogId, undefined);
  } finally {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("an editor cannot attach death-date citations to another author's person", () => {
  const current = family();
  const next = structuredClone(current);
  next.people[0].deathDateClaim = { value: "1950-03-02", sources: [sourceCitation(source)] };
  const editor: ArchiveUser = {
    id: "editor", name: "Редактор", role: "researcher", createdAt: "2026-01-01",
  };
  assert.throws(() => authorizeArchive(next, current, editor), /только свои карточки/);
});

test("HTTP changes save death-date citation, reject a new date and protect the linked source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-death-http-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const seed = await app.archive.read();
    await app.archive.write(family(), seed.revision);
    await sourceCatalogStore(app.archive.db).insert(source);
    const before = await (await fetch(`${origin}/api/family`)).json();
    const next = structuredClone(before.family) as Family;
    next.people[0].deathDateClaim = { value: "1950-03-02", sources: [sourceCitation(source)] };
    const post = (changes: ReturnType<typeof archiveChanges>, revision: number) =>
      fetch(`${origin}/api/family/changes`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "If-Match": String(revision),
      }, body: JSON.stringify({ changes }) });
    assert.equal((await post(archiveChanges(before.family, next), before.revision)).status, 200);
    assert.equal((await app.archive.read()).family.people[0].deathDateClaim?.sources[0].catalogId, source.id);
    const deleteLinked = await fetch(`${origin}/api/sources/${source.id}`, {
      method: "DELETE", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(deleteLinked.status, 409);
    const after = await app.archive.read();
    const changed = structuredClone(after.family);
    changed.people[0].death = "1951-03-02";
    assert.equal((await post(archiveChanges(after.family, changed), after.revision)).status, 400);
    assert.equal((await app.archive.read()).family.people[0].death, "1950-03-02");
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
