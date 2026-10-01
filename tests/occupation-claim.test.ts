import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveChanges } from "../src/domain/changes.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { openArchive } from "../src/server/database.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { startServer } from "../src/server/index.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { allCitations, sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";

const catalogSource: CatalogSource = {
  id: "occupation-register", title: "Цеховая книга", type: "архивная запись",
  author: "", institution: "", archive: "ГАСО", fond: "6", opis: "13",
  delo: "104", sheet: "7", reference: "л. 7", url: "", accessedAt: "",
  description: "", documentIds: [],
};
const family = (): Family => ({
  title: "Родословная", description: "", demo: false,
  people: [{ id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
    sex: "f", birth: "1880", birthPlace: "Тула", occupation: "Столяр",
    parents: [], spouses: [], generation: 1, column: 0, sources: [],
    createdBy: "admin" }],
});

test("occupation citation is bound to its wording and survives catalog and .drevo operations", async () => {
  const archive = await openArchive(":memory:", family());
  const directory = await mkdtemp(join(tmpdir(), "drevo-occupation-claim-"));
  try {
    await sourceCatalogStore(archive.db).insert(catalogSource);
    const next = (await archive.read()).family;
    next.people[0].occupationClaim = {
      value: "Столяр", sources: [sourceCitation(catalogSource)], confidence: "probable",
    };
    await archive.write(next, (await archive.read()).revision);
    const stored = (await archive.read()).family;
    assert.equal(stored.people[0].occupationClaim?.sources[0].catalogId, catalogSource.id);
    assert.equal(allCitations(stored).length, 1);

    const changed = structuredClone(stored);
    changed.people[0].occupation = "Учитель";
    assert.throws(() => validateFamily(changed), /Источник занятия относится к другому значению/);
    await assert.rejects(archive.write(changed, (await archive.read()).revision), /Источник занятия/);
    const foreign = structuredClone(stored);
    foreign.people[0].occupationClaim!.sources[0].catalogId = "another-archive";
    await assert.rejects(archive.write(foreign, (await archive.read()).revision), /Источник отсутствует/);

    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...catalogSource, title: "Уточнённая книга" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    assert.equal((await archive.read()).family.people[0].occupationClaim?.sources[0].title,
      "Уточнённая книга");

    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const path = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads, {
      family: (await archive.read()).family, documents: [], comments: [],
      sources: [{ ...catalogSource, title: "Уточнённая книга" }],
    }, async () => {});
    const portable = await readPortablePackage(path, stage);
    assert.equal(portable.snapshot.family.people[0].occupationClaim?.sources[0].catalogId,
      catalogSource.id);
    assert.equal(portable.snapshot.family.people[0].occupationClaim?.confidence, "probable");
  } finally {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("GEDCOM 5.5.1/7 and external OCCU.SOUR retain exact occupation evidence", () => {
  const person = family().people[0];
  person.occupationClaim = { value: "Столяр", sources: [sourceCitation(catalogSource)] };
  for (const version of ["5.5.1", "7.0"] as const) {
    const text = exportGedcom({ ...family(), people: [person] }, { version });
    assert.match(text, /1 OCCU Столяр\r\n2 SOUR @S\d+@\r\n3 PAGE л\. 7\r\n3 _DREVO_CLAIM OCCUPATION/);
    const imported = importGedcom(text, `other-${version}`).family.people[0];
    assert.equal(imported.occupationClaim?.value, "Столяр");
    assert.equal(imported.occupationClaim?.sources[0].title, catalogSource.title);
    assert.equal(imported.occupationClaim?.sources[0].catalogId, undefined);
    assert.deepEqual(imported.sources, []);

    const external = text.replace("3 _DREVO_CLAIM OCCUPATION\r\n", "")
      .replace(/^1 _DREVO .+\r\n/m, "");
    const ordinary = importGedcom(external, `external-${version}`).family.people[0];
    assert.equal(ordinary.occupationClaim?.sources[0].reference, "л. 7");
    assert.deepEqual(ordinary.events?.[0].sources, []);
    const noEvidence = importGedcom(exportGedcom(family(), { version }),
      `legacy-${version}`).family.people[0];
    assert.equal(noEvidence.occupationClaim, undefined);
  }
});

test("GEDZIP remaps an occupation citation document without duplicating a work event", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-occupation-gedzip-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const documentId = "11111111-1111-4111-8111-111111111111";
    const bytes = Buffer.from("%PDF-1.4\noccupation\n%%EOF");
    await writeFile(join(uploads, "record.pdf"), bytes);
    const archive = family();
    archive.people[0].occupationClaim = { value: "Столяр", sources: [{
      title: "Цеховая книга", type: "архив", reference: "л. 7",
      documentId, documentPage: 4,
    }] };
    archive.people[0].events = [{ id: "work", type: "work", title: "Столяр",
      sources: [{ title: "Договор", type: "архив", reference: "л. 8" }] }];
    const path = join(directory, "family.gdz");
    await writeGenealogyPackage(path, uploads, archive, [{
      id: documentId, file: "documents/record.pdf", title: "Цеховая книга",
      mime: "application/pdf", personIds: [], portraitIds: [],
      document: { documentType: "", documentDate: "", place: "",
        description: "", provenance: "" },
    }]);
    const result = await prepareGenealogyImport(path, stage, "imported");
    const imported = result.family.people[0];
    assert.equal(imported.events?.filter((event) =>
      event.type === "work" && event.title === "Столяр").length, 1);
    assert.equal(imported.occupationClaim?.sources[0].documentPage, 4);
    assert.equal(imported.occupationClaim?.sources[0].documentId, result.files[0].documentId);
    assert.notEqual(result.files[0].documentId, documentId);
    assert.deepEqual(await readFile(join(stage, result.files[0].name)), bytes);
    assert.equal(imported.events?.[0].sources?.[0].title, "Договор");

    const plain = exportGedcom(archive, { version: "7.0", media: [{
      id: documentId, file: "documents/record.pdf", title: "Цеховая книга",
      personIds: [], portraitIds: [], document: { documentType: "",
        documentDate: "", place: "", description: "", provenance: "" },
    }] });
    const plainPath = join(directory, "plain.ged");
    await writeFile(plainPath, plain);
    const unavailable = await prepareGenealogyImport(plainPath, stage, "plain");
    assert.equal(unavailable.family.people[0].occupationClaim?.sources[0].documentId, undefined);
    assert.ok(unavailable.warnings.some((warning) => warning.includes("Вложение цитаты не загружено")));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("occupation claim HTTP changes enforce value, catalog, ownership and assessment rights", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-occupation-http-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const seed = await app.archive.read();
    await app.archive.write(family(), seed.revision);
    await sourceCatalogStore(app.archive.db).insert(catalogSource);
    const before = await (await fetch(`${origin}/api/family`)).json();
    const next = structuredClone(before.family) as Family;
    next.people[0].occupationClaim = { value: "Столяр", sources: [sourceCitation(catalogSource)] };
    const post = (current: Family, changed: Family, revision: number) =>
      fetch(`${origin}/api/family/changes`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "If-Match": String(revision),
      }, body: JSON.stringify({ changes: archiveChanges(current, changed) }) });
    assert.equal((await post(before.family, next, before.revision)).status, 200);
    const saved = await app.archive.read();
    assert.equal(saved.family.people[0].occupationClaim?.sources[0].catalogId, catalogSource.id);
    const deleteLinked = await fetch(`${origin}/api/sources/${catalogSource.id}`, {
      method: "DELETE", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(deleteLinked.status, 409);
    const changed = structuredClone(saved.family);
    changed.people[0].occupation = "Учитель";
    assert.equal((await post(saved.family, changed, saved.revision)).status, 400);
    assert.equal((await app.archive.read()).family.people[0].occupation, "Столяр");

    const other: ArchiveUser = { id: "other", name: "Другой", role: "researcher",
      createdAt: "2026-01-01" };
    assert.throws(() => authorizeArchive(next, family(), other), /только свои карточки/);
    const relative: ArchiveUser = { id: "admin", name: "Родственник", role: "relative",
      createdAt: "2026-01-01" };
    const assessed = structuredClone(saved.family);
    assessed.people[0].occupationClaim!.confidence = "confirmed";
    assert.throws(() => authorizeArchive(assessed, saved.family, relative), /только исследователь/);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});
