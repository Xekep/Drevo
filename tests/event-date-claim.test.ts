import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveChanges } from "../src/domain/changes.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { claimableEventDate } from "../src/domain/person-events.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
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

const source: CatalogSource = { id: "event-date-register", title: "Ведомость переездов",
  type: "архив", author: "", institution: "", archive: "ГАСО", fond: "6",
  opis: "13", delo: "104", sheet: "8", reference: "л. 8", url: "",
  accessedAt: "", description: "", documentIds: [] };
const family = (): Family => ({ title: "Семья", description: "", demo: false,
  people: [{ id: "anna", name: "Анна", surname: "Тестова", patronymic: "",
    sex: "f", birth: "1880", birthPlace: "Тула", parents: [], spouses: [],
    generation: 1, column: 0, sources: [], createdBy: "owner",
    events: [{ id: "move", type: "move", date: "1901", place: "Москва",
      sources: [{ title: "Общее письмо", type: "письмо", reference: "л. 2" }] }] }],
});
const cite = (data: Family) => {
  data.people[0].events![0].dateClaim = { value: "1901", sources: [sourceCitation(source)] };
};
const actor = (id: string, role: ArchiveUser["role"]): ArchiveUser => ({
  id, role, name: id, createdAt: "2026-01-01",
});

test("event date citation has its own catalog slot and rejects changed or ranged dates", async () => {
  const archive = await openArchive(":memory:", family());
  try {
    await sourceCatalogStore(archive.db).insert(source);
    const before = (await archive.read()).family;
    const next = structuredClone(before);
    cite(next);
    assert.throws(() => authorizeArchive(next, before, actor("owner", "relative")),
      /только администратор/);
    assert.throws(() => authorizeArchive(next, before, actor("other", "researcher")),
      /только свои карточки/);
    await archive.write(authorizeArchive(next, before, actor("owner", "admin")),
      (await archive.read()).revision);
    const stored = (await archive.read()).family;
    assert.equal(stored.people[0].events![0].dateClaim?.sources[0].catalogId, source.id);
    assert.equal(allCitations(stored).length, 2, "general event evidence stays separate");
    const changed = structuredClone(stored);
    changed.people[0].events![0].date = "1902";
    assert.throws(() => validateFamily(changed), /Источник даты события относится к другому значению/);
    await assert.rejects(archive.write(changed, (await archive.read()).revision), /Источник даты события/);
    const range = structuredClone(stored);
    range.people[0].events![0].endDate = "1902";
    assert.throws(() => validateFamily(range), /Источник даты события/);
    const approximate = structuredClone(stored);
    approximate.people[0].events![0].dateText = "ABT 1901";
    assert.throws(() => validateFamily(approximate), /Источник даты события/);
    const foreign = structuredClone(stored);
    foreign.people[0].events![0].dateClaim!.sources[0].catalogId = "other-archive";
    await assert.rejects(archive.write(foreign, (await archive.read()).revision), /Источник отсутствует/);
    const cleared = structuredClone(stored);
    cleared.people[0].events![0].date = "1902";
    cleared.people[0].events![0].dateClaim = undefined;
    await archive.write(cleared, (await archive.read()).revision);
    assert.equal((await archive.read()).family.people[0].events![0].dateClaim, undefined);
    assert.equal(claimableEventDate({ date: "1.1.1901" }), "1901-01-01");
    assert.equal(claimableEventDate({ date: "1901", endDate: "1902" }), undefined);

    await archive.write(stored, (await archive.read()).revision);
    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...source, title: "Исправленная ведомость" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    assert.equal((await archive.read()).family.people[0].events![0].dateClaim?.sources[0].title,
      "Исправленная ведомость");
  } finally { await archive.close(); }
});

test("HTTP rejects stale event date; .drevo and GEDCOM 5.5.1/7 preserve distinct citations", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-event-date-"));
  const app = await startServer(0, join(directory, "archive.sqlite"), true);
  const origin = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  try {
    const seed = await app.archive.read();
    await app.archive.write(family(), seed.revision);
    await sourceCatalogStore(app.archive.db).insert(source);
    const before = await (await fetch(`${origin}/api/family`)).json();
    const next = structuredClone(before.family) as Family;
    cite(next);
    const post = (current: Family, changed: Family, revision: number) =>
      fetch(`${origin}/api/family/changes`, { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "If-Match": String(revision),
      }, body: JSON.stringify({ changes: archiveChanges(current, changed) }) });
    assert.equal((await post(before.family, next, before.revision)).status, 200);
    const saved = await app.archive.read();
    const changed = structuredClone(saved.family);
    changed.people[0].events![0].date = "1902";
    assert.equal((await post(saved.family, changed, saved.revision)).status, 400);
    assert.equal((await app.archive.read()).family.people[0].events![0].date, "1901");
    const deleteLinked = await fetch(`${origin}/api/sources/${source.id}`, {
      method: "DELETE", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ version: 1 }),
    });
    assert.equal(deleteLinked.status, 409);

    const stage = join(directory, "stage"); await mkdir(stage);
    const path = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(path), join(directory, "uploads"), {
      family: saved.family, documents: [], comments: [], sources: [source],
    }, async () => {});
    const portable = await readPortablePackage(path, stage);
    assert.equal(portable.snapshot.family.people[0].events![0].dateClaim?.sources[0].catalogId,
      source.id);
    for (const version of ["5.5.1", "7.0"] as const) {
      const twoEvents = structuredClone(saved.family);
      twoEvents.people[0].events!.push({ id: "move-two", type: "move", date: "1902",
        dateClaim: { value: "1902", sources: [{ title: "Ведомость переездов",
          type: "архив", reference: "л. 9" }] },
        sources: [{ title: "Заметка", type: "письмо", reference: "л. 3" }] });
      const text = exportGedcom(twoEvents, { version });
      assert.match(text, /3 _DREVO_CLAIM EVENT_DATE/);
      const events = importGedcom(text, `other-${version}`).family.people[0].events!;
      const first = events.find((event) => event.id === "move")!;
      const second = events.find((event) => event.id === "move-two")!;
      assert.equal(first.dateClaim?.value, "1901");
      assert.equal(first.dateClaim?.sources[0].reference, "л. 8");
      assert.equal(first.dateClaim?.sources[0].catalogId, undefined);
      assert.equal(first.sources?.[0].title, "Общее письмо");
      assert.equal(second.dateClaim?.sources[0].reference, "л. 9");
      assert.equal(second.sources?.[0].reference, "л. 3");
      const external = text.replace(/^1 _DREVO .+\r\n/m, "");
      const parsed = importGedcom(external, `external-${version}`).family.people[0].events!;
      assert.equal(parsed.find((event) => event.date === "1901")?.dateClaim?.sources[0].reference,
        "л. 8");
      assert.equal(parsed.find((event) => event.date === "1902")?.dateClaim?.sources[0].reference,
        "л. 9");
    }
    assert.equal(importGedcom(exportGedcom(family(), { version: "7.0" }), "legacy")
      .family.people[0].events!.find((event) => event.id === "move")?.dateClaim, undefined);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("GEDZIP remaps a date-cited PDF and shared link hides its local document ID", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-event-date-gedzip-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads); await mkdir(stage);
    const documentId = "11111111-1111-4111-8111-111111111111";
    const bytes = Buffer.from("%PDF-1.4\nevent date\n%%EOF");
    await writeFile(join(uploads, "record.pdf"), bytes);
    const data = family();
    data.people[0].events![0].dateClaim = { value: "1901", sources: [{
      title: "Ведомость переездов", type: "архив", reference: "л. 8",
      documentId, documentPage: 4,
    }] };
    const path = join(directory, "family.gdz");
    await writeGenealogyPackage(path, uploads, data, [{ id: documentId,
      file: "documents/record.pdf", title: "Ведомость переездов", mime: "application/pdf",
      personIds: [], portraitIds: [], document: { documentType: "", documentDate: "",
        place: "", description: "", provenance: "" },
    }]);
    const imported = await prepareGenealogyImport(path, stage, "other");
    const citation = imported.family.people[0].events!.find((event) => event.type === "move")!
      .dateClaim!.sources[0];
    assert.equal(citation.documentPage, 4);
    assert.equal(citation.documentId, imported.files[0].documentId);
    assert.notEqual(citation.documentId, documentId);
    assert.deepEqual(await readFile(join(stage, imported.files[0].name)), bytes);
    const share = sharedFamily(data, { id: "share", title: "Фрагмент", anchorId: "anna",
      personIds: ["anna"], createdAt: "2026-01-01", expiresAt: "2027-01-01",
      createdBy: "owner", createdName: "owner", revokedAt: null, lastVisitedAt: null }, "token");
    assert.equal(share.people[0].events![0].dateClaim?.sources[0].documentId, undefined);
    assert.equal(share.people[0].events![0].dateClaim?.sources[0].documentPage, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("BIRT/DEAT EVENT_DATE markers survive as exact or warned general evidence", () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    const input = ["0 HEAD", "1 GEDC", `2 VERS ${version}`,
      "0 @I1@ INDI", "1 NAME Анна /Тестова/",
      "1 BIRT", "2 DATE 1 JAN 1880", "2 SOUR @S1@",
      "3 PAGE л. 4", "3 _DREVO_CLAIM EVENT_DATE",
      "1 DEAT", "2 DATE ABT 1940", "2 SOUR @S2@",
      "3 PAGE л. 5", "3 _DREVO_CLAIM EVENT_DATE",
      "1 RESI", "2 DATE FROM 1901 TO 1903", "2 SOUR @S3@",
      "3 PAGE л. 6", "3 _DREVO_CLAIM EVENT_DATE",
      "0 @S1@ SOUR", "1 TITL Метрическая книга",
      "0 @S2@ SOUR", "1 TITL Книга смертей",
      "0 @S3@ SOUR", "1 TITL Перепись проживания", "0 TRLR", ""].join("\n");
    const result = importGedcom(input, `birth-death-${version}`);
    const person = result.family.people[0];
    const birth = person.events!.find((event) => event.gedcomTag === "BIRT")!;
    const death = person.events!.find((event) => event.gedcomTag === "DEAT")!;
    assert.equal(birth.dateClaim?.value, "1880-01-01");
    assert.equal(birth.dateClaim?.sources[0].reference, "л. 4");
    assert.equal(person.birthDateClaim, undefined);
    assert.equal(death.dateClaim, undefined);
    assert.equal(death.sources?.[0].reference, "л. 5");
    const ranged = person.events!.find((event) => event.gedcomTag === "RESI")!;
    assert.equal(ranged.dateClaim, undefined);
    assert.equal(ranged.sources?.[0].reference, "л. 6");
    assert.ok(result.warnings.some((warning) => warning.includes("без одиночной распознанной даты")));

    const data = family();
    data.people[0].events!.push({ id: "birth-event", gedcomTag: "BIRT", type: "other",
      date: "1880-01-01", dateClaim: { value: "1880-01-01", sources: [{
        title: "Метрическая книга", type: "архив", reference: "л. 4",
      }] } });
    data.people[0].events!.push({ id: "death-event", gedcomTag: "DEAT", type: "other",
      date: "1940", dateClaim: { value: "1940", sources: [{
        title: "Книга смертей", type: "архив", reference: "л. 5",
      }] } });
    const roundTrip = importGedcom(exportGedcom(data, { version }), `round-${version}`);
    assert.equal(roundTrip.family.people[0].events?.find((event) => event.id === "birth-event")
      ?.dateClaim?.sources[0].reference, "л. 4");
    assert.equal(roundTrip.family.people[0].events?.find((event) => event.id === "death-event")
      ?.dateClaim?.sources[0].reference, "л. 5");
  }
});
