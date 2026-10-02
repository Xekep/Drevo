import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeArchiveCoverage,
  qualityCategory,
} from "../src/domain/archive-coverage.ts";
import type { Family, Person } from "../src/domain/types.ts";
import { projectFamilyForUser } from "../src/domain/tree-access.ts";

function person(id: string, extra: Partial<Person> = {}): Person {
  return {
    id,
    surname: "Иванов",
    name: id,
    patronymic: "",
    sex: "u",
    birth: "",
    birthPlace: "",
    parents: [],
    spouses: [],
    generation: 0,
    column: 0,
    sources: [],
    ...extra,
  };
}

function family(people: Person[]): Family {
  return { title: "Тест", description: "", demo: false, people };
}

test("coverage prompts point to the exact card or event without calling absent evidence false", () => {
  const people = [
    person("unsourced", {
      birth: "1900",
      birthPlace: "Тверь",
      events: [{ id: "move", type: "move", date: "1920", title: "Переезд" }],
    }),
    person("sourced", {
      birth: "1901",
      sources: [
        { title: "Метрическая книга", type: "archive", reference: "1" },
      ],
      events: [
        {
          id: "marriage",
          type: "marriage",
          date: "1925",
          sources: [{ title: "Акт", type: "archive", reference: "2" }],
        },
      ],
    }),
    person("empty"),
  ];
  const original = structuredClone(people);
  const warnings = analyzeArchiveCoverage(family(people));
  assert.deepEqual(people, original);
  assert.deepEqual(
    warnings.map(({ code, personIds, eventId }) => ({
      code,
      personIds,
      eventId,
    })),
    [
      { code: "unsourced-card", personIds: ["unsourced"], eventId: undefined },
      { code: "unsourced-event", personIds: ["unsourced"], eventId: "move" },
      { code: "unsourced-card", personIds: ["sourced"], eventId: undefined },
    ],
  );
  assert.equal(qualityCategory(warnings[0]), "gap");
  assert.equal(qualityCategory(warnings[1]), "unverified");
  assert.equal(qualityCategory(warnings[2]), "gap");
  assert.match(warnings[2].rule, /Общий источник карточки/);
  assert.ok(warnings.every((warning) => warning.level === "check"));
});

test("exact life-fact citations separate unassessed, manual uncertainty, conflict and missing evidence", () => {
  const source = (title: string) => ({ title, type: "архив", reference: "л. 1" });
  const warnings = analyzeArchiveCoverage(family([
    person("rated", {
      birth: "1900", birthDateClaim: { value: "1900", sources: [source("Рождение")], confidence: "confirmed" },
      birthPlace: "Тверь", birthPlaceClaim: { value: "Тверь", sources: [source("Место рождения")], confidence: "probable" },
      death: "1950", deathDateClaim: { value: "1950", sources: [source("Смерть")], confidence: "unknown" },
      deathPlace: "Москва", deathPlaceClaim: { value: "Москва", sources: [source("Место смерти")], confidence: "conflicting" },
    }),
    person("legacy", {
      birth: "1901", birthDateClaim: { value: "1901", sources: [source("Старая запись")] },
      birthPlace: "Калуга", sources: [source("Общий источник карточки")],
    }),
    person("mismatch", {
      birth: "1902", birthDateClaim: { value: "1901", sources: [source("Прежняя дата")], confidence: "confirmed" },
    }),
  ]));
  assert.deepEqual(warnings.map(({ code, personIds }) => [code, personIds[0]]), [
    ["unconfirmed-life-facts", "rated"], ["conflicting-life-facts", "rated"],
    ["unsourced-card", "legacy"], ["unconfirmed-life-facts", "legacy"],
    ["unsourced-card", "mismatch"],
  ]);
  assert.equal(qualityCategory(warnings[0]), "unverified");
  assert.equal(qualityCategory(warnings[1]), "contradiction");
  assert.deepEqual(warnings[0].sourceTitles, ["Место рождения", "Смерть"]);
  assert.deepEqual(warnings[1].sourceTitles, ["Место смерти"]);
  assert.match(warnings[0].detail, /Вероятно.*Неизвестно/);
  assert.match(warnings[1].rule, /добавьте альтернативную запись/);
  assert.match(warnings[2].detail, /место рождения Калуга/);
  assert.doesNotMatch(warnings[2].detail, /дата рождения/);
  assert.match(warnings[3].detail, /оценка не задана/);
  assert.equal(warnings.filter((warning) => warning.code === "unsourced-card" &&
    warning.personIds[0] === "legacy").length, 1);
});

test("quality filters keep errors, contradictions, possible errors and duplicates separate", () => {
  const warning = (code: string, level: "error" | "check") => ({
    code,
    level,
    title: "",
    detail: "",
    rule: "",
    personIds: ["one"],
  });
  assert.equal(qualityCategory(warning("self-parent", "error")), "error");
  assert.equal(
    qualityCategory(warning("death-before-birth", "error")),
    "contradiction",
  );
  assert.equal(
    qualityCategory(warning("young-parent", "check")),
    "possible-error",
  );
  assert.equal(
    qualityCategory(warning("possible-duplicate", "check")),
    "duplicate",
  );
});

test("quality warnings and counts only use people in a scoped or shared family projection", () => {
  const full = family([
    person("visible", { birth: "1900", createdBy: "viewer" }),
    person("secret", { name: "Секрет", birth: "1901", createdBy: "other",
      birthDateClaim: { value: "1901", sources: [{ title: "Скрытый архив", type: "архив", reference: "1" }],
        confidence: "conflicting" } }),
  ]);
  const scoped = projectFamilyForUser(full, {
    id: "viewer", name: "Участник", role: "relative", createdAt: "2026-01-01",
    treeAccess: "common_ancestors", personId: "visible",
  });
  const scopedWarnings = analyzeArchiveCoverage(scoped);
  assert.deepEqual(scopedWarnings.map((warning) => warning.personIds), [["visible"]]);
  assert.equal(scopedWarnings.filter((warning) => qualityCategory(warning) === "contradiction").length, 0);
  assert.doesNotMatch(JSON.stringify(scopedWarnings), /Секрет|Скрытый архив|secret/);
  const sharedProjection = family([full.people[0]]);
  assert.deepEqual(analyzeArchiveCoverage(sharedProjection), scopedWarnings);
});
