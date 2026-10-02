import test from "node:test";
import assert from "node:assert/strict";
import { createWriteStream } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeArchiveCoverage, qualityCategory } from "../src/domain/archive-coverage.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { preserveBirthSurnameClaim } from "../src/domain/person-fact-alternatives.ts";
import { collectPersonSources } from "../src/domain/person-sources.ts";
import { validateFamily } from "../src/domain/validation.ts";
import type { ArchiveUser, Family, PersonFactAlternative } from "../src/domain/index.ts";
import { openArchive } from "../src/server/database.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
import { readPortablePackage } from "../src/server/portable-import.ts";
import { writePortablePackage } from "../src/server/portable-package.ts";
import { allCitations, sourceCatalogStore } from "../src/server/source-catalog-store.ts";
import { sourceCitation, type CatalogSource } from "../src/shared/source-catalog.ts";

const source: CatalogSource = { id: "second-record", title: "Другая метрическая запись",
  type: "архив", author: "", institution: "", archive: "ГАСО", fond: "6",
  opis: "13", delo: "104", sheet: "", reference: "", url: "", accessedAt: "",
  description: "", documentIds: [] };
const inline = { title: "Первая метрическая запись", type: "архив", reference: "л. 1" };
const family = (): Family => ({ title: "Тест", description: "", demo: false, people: [{
  id: "anna", name: "Анна", surname: "Тестова", patronymic: "", sex: "f",
  birth: "1880", birthPlace: "Тула", parents: [], spouses: [], generation: 1,
  column: 0, sources: [], createdBy: "owner",
  birthDateClaim: { value: "1880", sources: [inline], confidence: "confirmed" },
}] });
const alternative = (): PersonFactAlternative => ({ id: "alternate-1", field: "birth",
  value: "1881", sources: [sourceCitation(source)], confidence: "probable" });
const actor = (role: ArchiveUser["role"]): ArchiveUser => ({
  id: "owner", name: "Анна", role, createdAt: "2026-01-01",
});

test("alternative life records remain distinct, source-backed and date-validated", () => {
  const valid = family();
  valid.people[0].factAlternatives = [alternative(), { id: "alternate-place",
    field: "birthPlace", value: "Калуга", sources: [inline] }];
  assert.doesNotThrow(() => validateFamily(valid));
  const invalid = (change: (value: Family) => void) => {
    const value = structuredClone(valid);
    change(value);
    assert.throws(() => validateFamily(value), /альтернативные значения/);
  };
  invalid((value) => { value.people[0].factAlternatives![0].sources = []; });
  invalid((value) => { value.people[0].factAlternatives![0].value = "1880"; });
  invalid((value) => { value.people[0].factAlternatives![0].value = "1881-13"; });
  invalid((value) => { value.people[0].factAlternatives![1].id = "alternate-1"; });
  invalid((value) => { value.people[0].factAlternatives![1].value = "Тула"; });
  invalid((value) => { value.people[0].factAlternatives!.push({
    ...alternative(), id: "alternate-2",
  }); });
});

test("only a researcher assesses or removes an assessed alternative; identity cannot carry citations", () => {
  const before = family();
  before.people[0].factAlternatives = [{ ...alternative(), confidence: undefined }];
  const assessed = structuredClone(before);
  assessed.people[0].factAlternatives![0].confidence = "probable";
  assert.throws(() => authorizeArchive(assessed, before, actor("relative")),
    /Статус достоверности/);
  assert.equal(authorizeArchive(assessed, before, actor("researcher"))
    .people[0].factAlternatives?.[0].confidence, "probable");
  const removed = structuredClone(assessed);
  removed.people[0].factAlternatives = [];
  assert.throws(() => authorizeArchive(removed, assessed, actor("relative")),
    /Оценённый вариант/);
  assert.deepEqual(authorizeArchive(removed, assessed, actor("admin"))
    .people[0].factAlternatives, []);
  const moved = structuredClone(assessed);
  moved.people[0].factAlternatives![0].value = "1882";
  assert.throws(() => authorizeArchive(moved, assessed, actor("admin")),
    /удалите прежний вариант/);
});

test("competing citations appear in quality warnings and source lists without choosing a value", () => {
  const value = family();
  value.people[0].factAlternatives = [alternative()];
  const warnings = analyzeArchiveCoverage(value);
  const competing = warnings.find((warning) => warning.code === "competing-life-evidence");
  assert.ok(competing);
  assert.equal(qualityCategory(competing), "contradiction");
  assert.match(competing.detail, /1880 и 1881/);
  assert.deepEqual(competing.sourceTitles,
    ["Первая метрическая запись", "Другая метрическая запись"]);
  assert.equal(value.people[0].birth, "1880");
  assert.ok(collectPersonSources(value.people[0]).some((entry) =>
    entry.origin === "Другая дата рождения: 1881"));
  const shared = structuredClone(value.people[0]);
  shared.factAlternatives![0].sources = [{ ...inline }];
  assert.match(collectPersonSources(shared).find((entry) =>
    entry.title === inline.title)!.origin || "", /Дата рождения; Другая дата рождения: 1881/);
  delete value.people[0].birthDateClaim;
  assert.equal(analyzeArchiveCoverage(value).some((warning) =>
    warning.code === "competing-life-evidence"), false,
  "one sourced alternative and an unsourced current value are not two conflicting witnesses");
  value.people[0].factAlternatives!.push({ ...alternative(), id: "alternate-2",
    value: "1882", sources: [{ ...inline, title: "Третья запись" }] });
  assert.match(analyzeArchiveCoverage(value).find((warning) =>
    warning.code === "competing-life-evidence")!.detail, /1881 и 1882/,
  "two alternative witnesses still conflict when the current value is uncited");
});

test("catalog alternatives hydrate and survive a .drevo round trip", async () => {
  const archive = await openArchive(":memory:", family());
  const directory = await mkdtemp(join(tmpdir(), "drevo-alternatives-"));
  try {
    await sourceCatalogStore(archive.db).insert(source);
    const current = await archive.read();
    current.family.people[0].factAlternatives = [alternative()];
    await archive.write(current.family, current.revision);
    assert.equal(allCitations((await archive.read()).family).length, 2);
    await archive.db.transaction(async () => {
      await sourceCatalogStore(archive.db).update({ ...source, title: "Уточнённая запись" }, 1);
      await archive.db.prepare("UPDATE archive SET revision=revision+1 WHERE id=1").run();
    });
    const stored = (await archive.read()).family;
    assert.equal(stored.people[0].factAlternatives?.[0].sources[0].title,
      "Уточнённая запись");
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const packagePath = join(directory, "archive.drevo");
    await writePortablePackage(createWriteStream(packagePath), uploads,
      { family: stored, sources: [{ ...source, title: "Уточнённая запись" }],
        documents: [], comments: [] }, async () => {});
    const imported = await readPortablePackage(packagePath, stage);
    assert.equal(imported.snapshot.family.people[0].factAlternatives?.[0].value, "1881");
    assert.equal(imported.snapshot.family.people[0].factAlternatives?.[0].sources[0].catalogId,
      source.id);
  } finally {
    await archive.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("GEDCOM 5.5.1 and 7 preserve distinct alternatives without leaking archive-local IDs", () => {
  const value = family();
  value.people[0].factAlternatives = [alternative()];
  for (const version of ["5.5.1", "7.0"] as const) {
    const text = exportGedcom(value, { version });
    assert.doesNotMatch(text, /"catalogId"|"documentId"/);
    const imported = importGedcom(text, `alternatives-${version}`).family.people[0];
    assert.equal(imported.birth, "1880");
    assert.equal(imported.factAlternatives?.[0].value, "1881");
    assert.equal(imported.factAlternatives?.[0].sources[0].title, source.title);
    assert.equal(imported.factAlternatives?.[0].sources[0].catalogId, undefined);
  }
});

test("changing a cited birth surname can retain the former value and its citation as an alternative", () => {
  const before = family();
  const person = before.people[0];
  person.maidenName = "Иванова";
  person.maidenNameClaim = { value: "Иванова", sources: [sourceCitation(source)],
    confidence: "confirmed" };
  const edited = structuredClone(before);
  edited.people[0].maidenName = "Петрова";
  assert.throws(() => validateFamily(edited), /Источник фамилии при рождении относится к другому значению/);
  edited.people[0] = preserveBirthSurnameClaim(edited.people[0], "old-birth-surname");
  edited.people[0].maidenNameClaim = { value: "Петрова", sources: [inline] };
  assert.doesNotThrow(() => validateFamily(edited));
  assert.equal(edited.people[0].factAlternatives?.[0].value, "Иванова");
  assert.equal(edited.people[0].factAlternatives?.[0].sources[0].catalogId, source.id);
  assert.equal(edited.people[0].factAlternatives?.[0].confidence, "confirmed");
  assert.equal(edited.people[0].maidenNameClaim?.sources[0].title, inline.title);
  assert.throws(() => authorizeArchive(edited, before, actor("relative")),
    /Статус достоверности/);
  assert.doesNotThrow(() => authorizeArchive(edited, before, actor("researcher")));
  const changedCitation = structuredClone(edited);
  changedCitation.people[0].factAlternatives![0].sources[0].reference = "другой лист";
  assert.throws(() => authorizeArchive(changedCitation, before, actor("researcher")),
    /Привязать каталожный источник/);
  const duplicatedCitation = structuredClone(edited);
  duplicatedCitation.people[0].maidenNameClaim!.sources.push(sourceCitation(source));
  assert.throws(() => authorizeArchive(duplicatedCitation, before, actor("researcher")),
    /Привязать каталожный источник/);
  const warning = analyzeArchiveCoverage(edited).find((item) =>
    item.code === "competing-life-evidence");
  assert.ok(warning);
  assert.match(warning.detail, /фамилия при рождении — Петрова и Иванова/);
  assert.deepEqual(warning.sourceTitles,
    [inline.title, source.title]);
  assert.ok(collectPersonSources(edited.people[0]).some((entry) =>
    entry.origin === "Другая фамилия при рождении: Иванова" && entry.catalogId === source.id));
  const invalid = structuredClone(edited);
  invalid.people[0].factAlternatives![0].sources = [];
  assert.throws(() => validateFamily(invalid), /альтернативные значения/);
});

test("a birth-surname alternative keeps its source through GEDCOM and .drevo", async () => {
  const value = family();
  value.people[0].maidenName = "Петрова";
  value.people[0].maidenNameClaim = { value: "Петрова", sources: [inline] };
  value.people[0].factAlternatives = [{ id: "old-birth-surname", field: "maidenName",
    value: "Иванова", sources: [sourceCitation(source)], confidence: "confirmed" }];
  for (const version of ["5.5.1", "7.0"] as const) {
    const imported = importGedcom(exportGedcom(value, { version }),
      `surname-alternative-${version}`).family.people[0];
    assert.equal(imported.maidenName, "Петрова");
    assert.equal(imported.factAlternatives?.[0].value, "Иванова");
    assert.equal(imported.factAlternatives?.[0].sources[0].title, source.title);
    assert.equal(imported.factAlternatives?.[0].sources[0].catalogId, undefined);
  }
  const directory = await mkdtemp(join(tmpdir(), "drevo-birth-surname-alternative-"));
  try {
    const uploads = join(directory, "uploads"), stage = join(directory, "stage");
    await mkdir(uploads);
    await mkdir(stage);
    const path = join(directory, "family.drevo");
    await writePortablePackage(createWriteStream(path), uploads,
      { family: value, sources: [source], documents: [], comments: [] }, async () => {});
    const restored = await readPortablePackage(path, stage);
    assert.equal(restored.snapshot.family.people[0].factAlternatives?.[0].value, "Иванова");
    assert.equal(restored.snapshot.family.people[0].factAlternatives?.[0].sources[0].catalogId,
      source.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
