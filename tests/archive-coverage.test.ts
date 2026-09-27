import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeArchiveCoverage,
  qualityCategory,
} from "../src/domain/archive-coverage.ts";
import type { Family, Person } from "../src/domain/types.ts";

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
    ],
  );
  assert.equal(qualityCategory(warnings[0]), "gap");
  assert.equal(qualityCategory(warnings[1]), "unverified");
  assert.ok(warnings.every((warning) => warning.level === "check"));
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
