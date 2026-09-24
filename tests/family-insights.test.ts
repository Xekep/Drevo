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
  assert.ok(
    result.facts.some(
      (fact) => fact.title === "Самая долгая жизнь" && fact.value === "85 лет",
    ),
  );
  assert.ok(
    result.facts.some(
      (fact) =>
        fact.title === "Больше всего детей" && fact.detail.includes("Алексей"),
    ),
  );
  assert.ok(
    result.facts.some(
      (fact) => fact.title === "Поколений одновременно" && fact.value === "3",
    ),
  );
  assert.equal(
    result.completeness.find((item) => item.label === "Дата рождения")?.value,
    4,
  );
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
      (warning) =>
        warning.title === "Ребёнок родился заметно позже смерти родителя",
    ),
  );
  assert.ok(
    result.warnings.some((warning) => warning.title === "Возможный дубль"),
  );
});

test("average lifespan by sex counts only known birth and death years", () => {
  const people = [
    person("m1", "Пётр", "1900", 1, { sex: "m", death: "1970" }),
    person("m2", "Иван", "1901", 1, { sex: "m", death: "1952" }),
    person("m-child", "Миша", "1940", 1, { sex: "m", death: "1941" }),
    person("f1", "Анна", "1910", 1, { sex: "f", death: "1990" }),
    person("living", "Мария", "1920", 1, { sex: "f" }),
    person("unknown", "Алексей", "", 1, { sex: "m", death: "1980" }),
    person("other", "Саша", "1900", 1, { sex: "u", death: "2000" }),
    person("reversed", "Николай", "1980", 1, { sex: "m", death: "1970" }),
  ];
  const facts = analyzeFamilyInsights({
    title: "Тест",
    description: "",
    demo: false,
    people,
  }).facts;
  const men = facts.find(
    (fact) => fact.title === "Средняя продолжительность жизни мужчин",
  );
  const women = facts.find(
    (fact) => fact.title === "Средняя продолжительность жизни женщин",
  );
  assert.equal(men?.value, "≈ 60,5 года");
  assert.match(men?.detail || "", /^2 человека/);
  assert.equal(women?.value, "≈ 80 лет");
  assert.match(women?.detail || "", /^1 человек/);
  assert.equal(facts.slice(-2)[0], men);
  assert.equal(facts.slice(-2)[1], women);

  const empty = analyzeFamilyInsights({
    title: "Пустой",
    description: "",
    demo: false,
    people: people.filter((item) => item.id === "living"),
  }).facts;
  assert.equal(empty.at(-2)?.value, "Нет данных");
  assert.equal(empty.at(-1)?.value, "Нет данных");
});

test("surname ranking combines feminine and masculine forms", () => {
  const people = [
    person("a", "Анна", "1900", 1, { sex: "f", surname: "Иванова" }),
    person("b", "Иван", "1900", 1, { sex: "m", surname: "Иванов" }),
    person("c", "Мария", "1900", 1, { sex: "f", surname: "Петровская" }),
    person("d", "Пётр", "1900", 1, { sex: "m", surname: "Петровский" }),
    person("e", "Елена", "1900", 1, { sex: "f", surname: "Скулко" }),
    person("f", "Василий", "1900", 1, { sex: "m", surname: "Скулко" }),
    person("g", "Ольга", "1900", 1, { sex: "f", surname: "Сова" }),
    person("h", "Николай", "1900", 1, { sex: "m", surname: "Сова" }),
    person("i", "Нина", "1900", 1, { sex: "f", surname: "Семёнова" }),
    person("j", "Семён", "1900", 1, { sex: "m", surname: "Семёнов" }),
  ];
  const result = analyzeFamilyInsights({
    title: "Тест",
    description: "",
    demo: false,
    people,
  });
  assert.deepEqual(
    result.topSurnames.map(({ label, count }) => [label, count]),
    [
      ["Иванов", 2],
      ["Петровский", 2],
      ["Семёнов", 2],
      ["Скулко", 2],
      ["Сова", 2],
    ],
  );
  assert.ok(
    result.facts.some(
      (fact) =>
        fact.title === "Самая частая фамилия" && fact.value === "Иванов",
    ),
  );
});

test("surname ranking prefers recorded masculine forms and preserves invariant names", () => {
  const people = [
    person("f1", "Анна", "1900", 1, { sex: "f", surname: "Калина" }),
    person("m1", "Иван", "1900", 1, { sex: "m", surname: "Калина" }),
    person("f2", "Мария", "1900", 1, { sex: "f", surname: "Большая" }),
    person("m2", "Пётр", "1900", 1, { sex: "m", surname: "Большой" }),
    person("f3", "Ольга", "1900", 1, { sex: "f", surname: "Тихая" }),
    person("f4", "Вера", "1900", 1, { sex: "f", surname: "Ильина" }),
  ];
  const result = analyzeFamilyInsights({
    title: "Тест",
    description: "",
    demo: false,
    people,
  });
  assert.deepEqual(
    result.topSurnames.map(({ label, count }) => [label, count]),
    [
      ["Большой", 2],
      ["Калина", 2],
      ["Ильин", 1],
      ["Тихая", 1],
    ],
  );
});
