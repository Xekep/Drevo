import test from "node:test";
import assert from "node:assert/strict";
import { analyzeArchiveWarnings } from "../src/domain/archive-quality.ts";
import { analyzeFamilyInsights } from "../src/domain/family-insights.ts";
import type { Family, Person } from "../src/domain/types.ts";

function person(id: string, extra: Partial<Person> = {}): Person {
  return {
    id,
    surname: "Иванов",
    name: id,
    patronymic: "",
    sex: "u",
    birth: "1980",
    birthPlace: "",
    parents: [],
    spouses: [],
    generation: 1,
    column: 0,
    sources: [],
    ...extra,
  };
}

function family(people: Person[], links: Family["links"] = []): Family {
  return { title: "Тест", description: "", demo: false, people, links };
}

test("archive quality finds malformed graph edges and cycles without changing people", () => {
  const people = [
    person("a", { parents: ["a", "b", "b", "c", "d"], spouses: ["b", "b"] }),
    person("b", { parents: ["c"] }),
    person("c", { parents: ["a"] }),
    person("d"),
  ];
  const snapshot = structuredClone(people);
  const warnings = analyzeArchiveWarnings(
    family(people, [
      { id: "step", from: "b", to: "a", type: "step_parent" },
      { id: "step-again", from: "b", to: "a", type: "step_parent" },
      { id: "self", from: "d", to: "d", type: "guardian" },
    ]),
  );
  const codes = new Set(warnings.map((warning) => warning.code));
  for (const code of [
    "self-parent",
    "repeated-parent",
    "repeated-spouse",
    "parent-and-spouse",
    "many-blood-parents",
    "parent-cycle",
    "blood-and-step-parent",
    "repeated-extra-link",
    "self-extra-link",
  ])
    assert.ok(codes.has(code), code);
  assert.deepEqual(people, snapshot);
  assert.ok(
    warnings.every((warning) => warning.rule && warning.personIds.length),
  );
  assert.equal(
    warnings.find((warning) => warning.code === "parent-and-spouse")?.level,
    "check",
  );
});

test("archive quality detects cycles that involve an adoptive parent", () => {
  const warnings = analyzeArchiveWarnings(
    family(
      [person("a", { parents: ["b"] }), person("b")],
      [{ id: "adopt", from: "a", to: "b", type: "adoptive_parent" }],
    ),
  );
  assert.equal(
    warnings.filter((warning) => warning.code === "parent-cycle").length,
    1,
  );
  assert.deepEqual(
    warnings
      .find((warning) => warning.code === "parent-cycle")
      ?.personIds.sort(),
    ["a", "b"],
  );
});

test("normal relationships and hidden projection edges do not become errors", () => {
  const warnings = analyzeArchiveWarnings(
    family(
      [
        person("parent", { birth: "1950", spouses: ["other"] }),
        person("other", { birth: "1952", spouses: ["parent"] }),
        person("child", {
          birth: "1980",
          parents: ["parent", "other", "hidden"],
        }),
        person("guardian", { birth: "1940" }),
      ],
      [{ id: "guardian", from: "guardian", to: "child", type: "guardian" }],
    ),
  );
  assert.deepEqual(warnings, []);
});

test("event warning retains its own sources and an uncertain duplicate stays a hint", () => {
  const warnings = analyzeArchiveWarnings(
    family([
      person("one", {
        name: "Анна",
        birth: "1950",
        events: [
          {
            id: "marriage",
            type: "marriage",
            date: "1940",
            sources: [
              { title: "Метрическая книга", type: "archive", reference: "12" },
            ],
          },
        ],
      }),
      person("two", { name: "Анна", birth: "1950" }),
    ]),
  );
  assert.deepEqual(
    warnings.find((warning) => warning.code === "marriage-before-birth")
      ?.sourceTitles,
    ["Метрическая книга"],
  );
  assert.equal(
    warnings.find((warning) => warning.code === "possible-duplicate")?.level,
    "check",
  );
});

test("summary retains all warnings so more than twenty can be inspected", () => {
  const people = Array.from({ length: 25 }, (_, index) =>
    person(`person-${index}`, { parents: [`person-${index}`] }),
  );
  const warnings = analyzeFamilyInsights(family(people)).warnings;
  assert.equal(
    warnings.filter((warning) => warning.code === "self-parent").length,
    25,
  );
});
