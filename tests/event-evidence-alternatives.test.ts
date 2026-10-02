import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { analyzeArchiveCoverage, qualityCategory } from "../src/domain/archive-coverage.ts";
import { generationReport } from "../src/domain/generation-report.ts";
import { collectPersonSources } from "../src/domain/person-sources.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { prepareGenealogyImport, writeGenealogyPackage } from "../src/server/genealogy-package.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";
import type { ArchiveUser, Family } from "../src/domain/index.ts";

const citation = (title: string) => ({ title, type: "книга", reference: "л. 7" });
const family = (): Family => ({ title: "Семья", description: "", demo: false,
  people: [{ id: "p1", name: "Анна", surname: "Тестова", patronymic: "",
    sex: "f", birth: "1880", birthPlace: "", parents: [], spouses: [],
    generation: 1, column: 0, createdBy: "owner", sources: [],
    events: [{ id: "move", type: "move", date: "1901", place: "Москва",
      dateClaim: { value: "1901", sources: [citation("Перепись")] },
      placeClaim: { value: "Москва", sources: [citation("Перепись")] },
      alternatives: [
        { id: "date-1902", field: "date", value: "1902",
          sources: [citation("Адресная книга")], confidence: "probable" },
        { id: "place-tula", field: "place", value: "Тула",
          sources: [citation("Письмо")], confidence: "conflicting" },
      ] }] }],
});
const user = (role: ArchiveUser["role"]): ArchiveUser => ({
  id: "owner", name: "Владелец", role, createdAt: "2026-01-01",
});

test("event alternatives require distinct cited values and protect researcher assessments", () => {
  const current = family();
  assert.doesNotThrow(() => validateFamily(current));
  const duplicate = structuredClone(current);
  duplicate.people[0].events![0].alternatives![0].value = "1901";
  assert.throws(() => validateFamily(duplicate), /альтернативные значения события/);
  const uncited = structuredClone(current);
  uncited.people[0].events![0].alternatives![0].sources = [];
  assert.throws(() => validateFamily(uncited), /альтернативные значения события/);
  const altered = structuredClone(current);
  altered.people[0].events![0].alternatives![0].value = "1903";
  assert.throws(() => authorizeArchive(altered, current, user("admin")), /другого значения/);
  const removed = structuredClone(current);
  removed.people[0].events![0].alternatives = [];
  assert.throws(() => authorizeArchive(removed, current, user("relative")), /Оценённый вариант/);
  assert.doesNotThrow(() => authorizeArchive(removed, current, user("researcher")));
  const retitled = structuredClone(current);
  retitled.people[0].events![0].title = "Другой переезд";
  assert.throws(() => authorizeArchive(retitled, current, user("relative")), /Оценённое утверждение/);
});

test("competing event records stay separate in card, quality view, GEDCOM and shared projection", () => {
  const original = family();
  const event = original.people[0].events![0];
  const warning = analyzeArchiveCoverage(original).find((item) =>
    item.code === "competing-event-evidence");
  assert.equal(qualityCategory(warning!), "contradiction");
  assert.deepEqual(warning?.sourceTitles, ["Перепись", "Адресная книга", "Письмо"]);
  assert.match(generationReport(original, new Set(["p1"])), /Другая дата события.*1902/);
  const sources = collectPersonSources(original.people[0]);
  assert.equal(sources.find((item) => item.title === "Письмо")?.origin,
    "Другое место события: Тула");
  const shareInput = structuredClone(original);
  shareInput.people[0].events![0].alternatives![0].sources[0].documentId =
    "11111111-1111-4111-8111-111111111111";
  const share = sharedFamily(shareInput, { id: "s", title: "Фрагмент", anchorId: "p1",
    personIds: ["p1"], createdAt: "2026-01-01", expiresAt: "2027-01-01",
    createdBy: "owner", createdName: "Владелец", revokedAt: null,
    lastVisitedAt: null }, "token");
  assert.equal(share.people[0].events?.[0].alternatives?.[1].value, "Тула");
  assert.equal(share.people[0].events?.[0].alternatives?.[0].sources[0].documentId, undefined);
  for (const version of ["5.5.1", "7.0"] as const) {
    const gedcom = exportGedcom(original, { version });
    assert.match(gedcom, /_DREVO_EVENT_ALTERNATIVE/);
    const imported = importGedcom(gedcom, `full-${version}`).family.people[0].events!
      .find((item) => item.id === "move")!;
    assert.deepEqual(imported.alternatives?.map((item) => ({
      id: item.id, field: item.field, value: item.value, confidence: item.confidence,
      sourceTitles: item.sources.map((source) => source.title),
    })), event.alternatives?.map((item) => ({
      id: item.id, field: item.field, value: item.value, confidence: item.confidence,
      sourceTitles: item.sources.map((source) => source.title),
    })));
    const standalone = importGedcom(gedcom.replace(/^1 _DREVO .+\r\n/m, ""),
      `standalone-${version}`).family.people[0].events!
      .find((item) => item.type === "move")!;
    assert.deepEqual(standalone.alternatives?.map((item) => ({
      id: item.id, field: item.field, value: item.value, confidence: item.confidence,
      sourceTitles: item.sources.map((source) => source.title),
    })), imported.alternatives?.map((item) => ({
      id: item.id, field: item.field, value: item.value, confidence: item.confidence,
      sourceTitles: item.sources.map((source) => source.title),
    })));
    assert.ok(!standalone.sources?.length);
  }
});

test("malformed GEDCOM event alternatives warn and leave the event importable", () => {
  const normal = exportGedcom(family(), { version: "7.0" })
    .replace(/^1 _DREVO .+\r\n/m, "");
  const cases = [
    normal.replace('"value":"1902"', '"value":"не дата"'),
    normal.replace('"id":"date-1902"', '"id":"$bad"'),
    normal.replace('"id":"place-tula"', '"id":"date-1902"'),
  ];
  for (const [index, gedcom] of cases.entries()) {
    assert.notEqual(gedcom, normal);
    const parsed = importGedcom(gedcom, `malformed-${index}`);
    assert.ok(parsed.warnings.some((warning) =>
      warning.includes("Повреждённый альтернативный вариант события")));
    assert.equal(parsed.family.people[0].events?.[0].alternatives?.length, 1);
  }
});

test("portable archive retains each event alternative and its catalog citation", async () => {
  const original = family();
  const catalog: CatalogSource = { id: "catalog-1", title: "Адресная книга", type: "книга",
    author: "", institution: "", archive: "", fond: "", opis: "", delo: "",
    sheet: "", reference: "л. 7", url: "", accessedAt: "", description: "",
    documentIds: [] };
  original.people[0].events![0].alternatives![0].sources[0] = sourceCitation(catalog);
  const directory = await mkdtemp(join(tmpdir(), "drevo-event-alternatives-"));
  try {
    const path = join(directory, "family.drevo"), stage = join(directory, "stage");
    await mkdir(stage);
    await writePortablePackage(createWriteStream(path), join(directory, "uploads"), {
      family: original, documents: [], comments: [], sources: [catalog],
    }, async () => {});
    const imported = await readPortablePackage(path, stage);
    assert.deepEqual(imported.snapshot.family.people[0].events?.[0].alternatives,
      original.people[0].events?.[0].alternatives);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("GEDZIP remaps the document cited by a competing event value", async () => {
  const directory = await mkdtemp(join(tmpdir(), "drevo-event-alternative-gedzip-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const documentId = "11111111-1111-4111-8111-111111111111";
    const bytes = Buffer.from("%PDF-1.4\ncompeting-date\n%%EOF");
    await writeFile(join(uploads, "record.pdf"), bytes);
    const original = family();
    original.people[0].events![0].alternatives![0].sources[0] = {
      ...citation("Адресная книга"), documentId, documentPage: 3,
    };
    const path = join(directory, "family.gdz");
    await writeGenealogyPackage(path, uploads, original, [{
      id: documentId, file: "documents/record.pdf", title: "Адресная книга",
      mime: "application/pdf", personIds: [], portraitIds: [],
      document: { documentType: "", documentDate: "", place: "",
        description: "", provenance: "" },
    }]);
    const imported = await prepareGenealogyImport(path, stage, "imported");
    const source = imported.family.people[0].events![0].alternatives![0].sources[0];
    assert.equal(source.documentPage, 3);
    assert.equal(source.documentId, imported.files[0].documentId);
    assert.notEqual(source.documentId, documentId);
    assert.deepEqual(await readFile(join(stage, imported.files[0].name)), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
