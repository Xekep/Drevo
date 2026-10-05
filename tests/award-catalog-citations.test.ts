import test from "node:test";
import assert from "node:assert/strict";
import type { Family, Person, Source } from "../src/domain/types.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { allCitations } from "../src/server/source-catalog-store.ts";
import { collectPersonSources } from "../src/domain/person-sources.ts";
import { visibleGenealogyHasCatalogLinks } from "../src/domain/visible-genealogy-catalog-warning.ts";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import { rebasePersonDraft } from "../src/domain/person-draft.ts";
import { generationReport } from "../src/domain/generation-report.ts";
import { archiveReport } from "../src/domain/archive-report.ts";
import { analysisExport } from "../src/domain/analysis-export.ts";
import { offlineFamily } from "../src/server/offline-package.ts";

const citation: Source = { catalogId: "award-file", title: "Наградной лист", type: "архив",
  reference: "л. 2", url: "https://example.test/award", documentId: "d0c00000-0000-4000-8000-000000000001",
  documentPage: 2 };
const person = (): Person => ({ id: "hero", name: "Иван", surname: "Примеров", patronymic: "",
  sex: "m", birth: "", birthPlace: "", parents: [], spouses: [], generation: 1,
  column: 0, sources: [], createdBy: "owner", awards: [{ id: "award-1", name: "Медаль за отвагу",
    year: "1945", source: { title: "Старая запись", url: "https://example.test/legacy" },
    sources: [citation] }] });
const family = (): Family => ({ title: "Награды", description: "", demo: false, people: [person()] });

test("award citation is validated, counted and scoped to its person", () => {
  const current = family();
  assert.doesNotThrow(() => validateFamily(current));
  assert.equal(allCitations(current).length, 1);
  assert.equal(collectPersonSources(current.people[0]).filter((source) => source.catalogId === "award-file").length, 1);
  assert.equal(visibleGenealogyHasCatalogLinks(current, new Set(["hero"])), true);
  assert.equal(visibleGenealogyHasCatalogLinks(current, new Set()), false);
  const invalid = structuredClone(current);
  invalid.people[0].awards![0].sources![0].documentPage = 2001;
  assert.throws(() => validateFamily(invalid), /источники награды/i);
});

test("hidden award owners disclose no catalog links; shared citation omits private PDF ID", () => {
  const data = family();
  data.people.push({ ...person(), id: "viewer", name: "Вера", awards: undefined,
    createdBy: "viewer" });
  const scoped = projectFamilyForUser(data, { id: "viewer", name: "Вера",
    role: "relative", createdAt: "2026-01-01", personId: "viewer",
    treeAccess: "common_ancestors" });
  assert.equal(scoped.people.some((item) => item.id === "hero"), false);
  assert.equal(allCitations(scoped).length, 0);
  assert.equal(visibleGenealogyHasCatalogLinks(scoped, new Set(["viewer"])), false);
  const share = sharedFamily(data, { id: "share", title: "Награда", anchorId: "hero",
    personIds: ["hero"], createdAt: "", expiresAt: "", createdBy: "owner",
    createdName: "Владелец", revokedAt: null, lastVisitedAt: null }, "token");
  assert.equal(share.people[0].awards?.[0].source?.title, "Старая запись");
  assert.equal(share.people[0].awards?.[0].sources?.[0].title, "Наградной лист");
  assert.equal(share.people[0].awards?.[0].sources?.[0].documentId, undefined);
  assert.equal(share.people[0].awards?.[0].sources?.[0].documentPage, undefined);
  const hiddenOffline = offlineFamily(scoped, "all");
  assert.equal(allCitations(hiddenOffline).length, 0);
  const visibleOffline = offlineFamily(data, "family", "hero", 0);
  assert.equal(visibleOffline.people[0].awards?.[0].sources?.[0].documentId,
    citation.documentId);
});

test("stale award edit cannot overwrite a citation added by another editor", () => {
  const base = person();
  delete base.awards![0].sources;
  const fresh = structuredClone(base);
  fresh.awards![0].sources = [citation];
  const draft = structuredClone(base);
  draft.awards![0].year = "1944";
  assert.throws(() => rebasePersonDraft(base, fresh, draft), /Утверждение изменилось/);
  const independent = structuredClone(base);
  independent.surname = "Уточнён";
  assert.deepEqual(rebasePersonDraft(base, fresh, independent).awards?.[0].sources,
    [citation], "independent top-level edits still merge");
});

test("visible award citations reach reports and source counts without exporting local document IDs", () => {
  const data = family();
  assert.match(generationReport(data, new Set(["hero"])), /Источник награды.*Наградной лист.*л\. 2/);
  const report = archiveReport(data, "person", "hero", 1);
  assert.ok(report.sections.some((section) => section.lines.some((line) =>
    line.includes("Источник награды: Наградной лист"))));
  const exported = analysisExport(data, 1, "2026-01-01T00:00:00Z");
  const award = exported.people[0].awards?.[0];
  assert.equal(award?.source?.title, "Старая запись");
  assert.equal(award?.sources?.[0].title, "Наградной лист");
  assert.doesNotMatch(JSON.stringify(award), /award-file|d0c00000-0000-4000-8000-000000000001/);
});

test("GEDCOM 5.5.1 and 7 retain award-bound text without local catalog/document IDs", () => {
  for (const version of ["5.5.1", "7.0"] as const) {
    const text = exportGedcom(family(), { version });
    assert.match(text, /1 SOUR @S\d+@\r?\n2 PAGE л\. 2\r?\n2 _DREVO_AWARD_ID award-1/);
    assert.doesNotMatch(text, /award-file|d0c00000-0000-4000-8000-000000000001/);
    const imported = importGedcom(text, `award-${version}`);
    const award = imported.family.people[0].awards?.[0];
    assert.equal(award?.source?.title, "Старая запись");
    assert.equal(award?.sources?.[0].title, "Наградной лист");
    assert.equal(award?.sources?.[0].reference, "л. 2");
    assert.equal(award?.sources?.[0].url, "https://example.test/award");
    assert.equal(award?.sources?.[0].catalogId, undefined);
    assert.equal(award?.sources?.[0].documentId, undefined);
    assert.ok(imported.warnings.some((warning) => warning.includes("каталогом источников")));
    const withoutExtension = text.replace(/(?:^|\r?\n)1 _DREVO [^\r\n]*(?:\r?\n2 CONC [^\r\n]*)*/,
      "");
    const fallback = importGedcom(withoutExtension, `award-plain-${version}`);
    assert.equal(fallback.family.people[0].awards, undefined);
    assert.equal(fallback.family.people[0].sources.length, 1,
      "an external tool dropping Drevo metadata retains the standard person citation");
    assert.ok(fallback.warnings.some((warning) => warning.includes("общий источник человека")));
  }
});
