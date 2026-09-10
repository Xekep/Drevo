import test from "node:test";
import assert from "node:assert/strict";
import { analyzeFamilyInsights } from "../src/domain/family-insights.ts";
import type { Family, Person } from "../src/domain/types.ts";

function person(
  id: string,
  name: string,
  birth: string,
  generation: number,
  extra: Partial<Person> = {},
): Person {
  return {
    id,
    surname: "Иванов",
    name,
    patronymic: "",
    sex: "u",
    birth,
    birthPlace: "Новоуральск",
    parents: [],
    spouses: [],
    generation,
    column: 0,
    sources: [],
    ...extra,
  };
}

test("family insights derive peaks, longevity, children and completeness", () => {
  const a = person("a", "Алексей", "1900", 1, {
      death: "1980",
      deceased: true,
      spouses: ["b"],
      sources: [{ title: "Архив", type: "record", reference: "1" }],
    }),
    b = person("b", "Мария", "1910", 1, {
      death: "1995",
      deceased: true,
      spouses: ["a"],
    }),
    c = person("c", "Николай", "1935", 2, {
      parents: ["a", "b"],
      events: [{ id: "move", type: "move", date: "1960", place: "Свердловск" }],
    }),
    d = person("d", "Сергей", "1965", 3, { parents: ["c"] });
  const family: Family = {
    title: "Тест",
    description: "",
    demo: false,
    people: [a, b, c, d],
    photos: [],
  };

  const result = analyzeFamilyInsights(family, 2000);
  assert.equal(result.totals.people, 4);
  assert.equal(result.totals.generations, 3);
  assert.equal(result.totals.events, 1);
  assert.equal(result.topSurnames[0].label, "Иванов");
  assert.equal(result.topSurnames[0].count, 4);
  assert.ok(result.facts.some((fact) => fact.title === "Долгожитель дерева" && fact.value === "85 лет"));
  assert.ok(result.facts.some((fact) => fact.title === "Больше всего детей" && fact.detail.includes("Алексей")));
  assert.ok(result.facts.some((fact) => fact.title === "Поколений одновременно" && fact.value === "3"));
  assert.equal(result.completeness.find((item) => item.label === "Дата рождения")?.value, 4);
});

test("family insights flag only clearly suspicious date relationships", () => {
  const parent = person("p", "Пётр", "1950", 1, {
      death: "1960",
      deceased: true,
    }),
    child = person("c", "Иван", "1970", 2, { parents: ["p"] }),
    duplicate = person("d", "Иван", "1970", 2);
  const result = analyzeFamilyInsights(
    {
      title: "Тест",
      description: "",
      demo: false,
      people: [parent, child, duplicate],
    },
    2000,
  );
  assert.ok(
    result.warnings.some(
      (warning) => warning.title === "Ребёнок родился заметно позже смерти родителя",
    ),
  );
  assert.ok(result.warnings.some((warning) => warning.title === "Возможный дубль"));
});
