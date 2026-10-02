import test from "node:test";
import assert from "node:assert/strict";
import { exportGedcom, importGedcom } from "../src/domain/gedcom.ts";
import { analyzeArchiveCoverage, qualityCategory } from "../src/domain/archive-coverage.ts";
import { generationReport } from "../src/domain/generation-report.ts";
import { sharedFamily } from "../src/domain/shared-family.ts";
import { validateFamily } from "../src/domain/validation.ts";
import { authorizeArchive } from "../src/server/permissions.ts";
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
});

test("competing event records stay separate in card, quality view, GEDCOM and shared projection", () => {
  const original = family();
  const event = original.people[0].events![0];
  const warning = analyzeArchiveCoverage(original).find((item) =>
    item.code === "competing-event-evidence");
  assert.equal(qualityCategory(warning!), "contradiction");
  assert.deepEqual(warning?.sourceTitles, ["Перепись", "Адресная книга", "Письмо"]);
  assert.match(generationReport(original, new Set(["p1"])), /Другая дата события.*1902/);
  const share = sharedFamily(original, { id: "s", title: "Фрагмент", anchorId: "p1",
    personIds: ["p1"], createdAt: "2026-01-01", expiresAt: "2027-01-01",
    createdBy: "owner", createdName: "Владелец", revokedAt: null,
    lastVisitedAt: null }, "token");
  assert.equal(share.people[0].events?.[0].alternatives?.[1].value, "Тула");
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
