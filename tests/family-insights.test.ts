import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeFamilyInsights,
  deceasedStatusSuggestion,
} from "../src/domain/family-insights.ts";
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

test("deceased hint uses a conservative age and never changes the recorded status", () => {
  const family: Family = {
    title: "Тест",
    description: "",
    demo: false,
    people: Array.from({ length: 5 }, (_, index) =>
      person(`historic-${index}`, "Анна", "1900", 1, { death: "1980" }),
    ),
  };
  const candidate = person("candidate", "Иван", "1934", 2);
  assert.deepEqual(deceasedStatusSuggestion(family, candidate, "2026-09-27"), {
    ageAtLeast: 91,
    averageYears: 80,
    sampleSize: 5,
  });
  assert.equal(candidate.deceased, undefined);
  assert.equal(
    deceasedStatusSuggestion(
      family,
      { ...candidate, birth: "1935" },
      "2026-09-27",
    ),
    null,
  );
  assert.equal(
    deceasedStatusSuggestion(
      family,
      { ...candidate, birth: "1935-09-26" },
      "2026-09-27",
    )?.ageAtLeast,
    91,
  );
  assert.equal(
    deceasedStatusSuggestion(
      family,
      { ...candidate, deceased: true },
      "2026-09-27",
    ),
    null,
  );
  assert.equal(
    deceasedStatusSuggestion(
      family,
      { ...candidate, deathPlace: "Москва" },
      "2026-09-27",
    ),
    null,
  );
  assert.equal(
    deceasedStatusSuggestion(
      { ...family, people: family.people.slice(0, 4) },
      candidate,
      "2026-09-27",
    ),
    null,
  );
});

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

test("date checks respect partial-date intervals and explain certain contradictions", () => {
  const checked = [
    person("death-before-birth", "Анна", "1950-07", 1, {
      death: "1950-06-30",
    }),
    person("overlapping-life", "Борис", "1950", 1, {
      death: "1950-01",
    }),
    person("events", "Вера", "1920", 1, {
      events: [
        { id: "marriage-early", type: "marriage", date: "1919" },
        { id: "marriage-overlap", type: "marriage", date: "1920-01" },
        {
          id: "period-reversed",
          type: "work",
          title: "Работа",
          date: "1951-02",
          endDate: "1951-01",
        },
        {
          id: "period-overlap",
          type: "work",
          title: "Учёба",
          date: "1951",
          endDate: "1951-01",
        },
      ],
    }),
    person("young-parent", "Глеб", "2000", 1),
    person("young-child", "Даша", "2010", 2, { parents: ["young-parent"] }),
    person("uncertain-parent", "Егор", "2000", 1),
    person("uncertain-child", "Женя", "2012", 2, {
      parents: ["uncertain-parent"],
    }),
    person("old-parent", "Зоя", "1900", 1),
    person("old-child", "Илья", "1982", 2, { parents: ["old-parent"] }),
    person("posthumous-parent", "Катя", "1990", 1, { death: "2010" }),
    person("posthumous-child", "Лев", "2011", 2, {
      parents: ["posthumous-parent"],
    }),
    person("late-child", "Маша", "2013", 2, { parents: ["posthumous-parent"] }),
    person("missing-parent", "Нина", "", 1, { death: "2000" }),
    person("missing-parent-birth-child", "Олег", "2002", 2, {
      parents: ["missing-parent"],
    }),
  ];
  const warnings = analyzeFamilyInsights({
    title: "Тест",
    description: "",
    demo: false,
    people: checked,
  }).warnings;
  const forPerson = (id: string) =>
    warnings.filter((warning) => warning.personIds.includes(id));

  assert.ok(
    forPerson("death-before-birth").some(
      (warning) => warning.title === "Дата смерти раньше рождения",
    ),
  );
  assert.equal(forPerson("overlapping-life").length, 0);
  assert.ok(
    forPerson("events").some(
      (warning) =>
        warning.title === "Брак раньше рождения" &&
        warning.eventId === "marriage-early",
    ),
  );
  assert.ok(
    forPerson("events").some(
      (warning) =>
        warning.title === "Конец события раньше начала" &&
        warning.eventId === "period-reversed",
    ),
  );
  assert.equal(
    forPerson("events").some(
      (warning) =>
        warning.eventId === "marriage-overlap" ||
        warning.eventId === "period-overlap",
    ),
    false,
  );
  assert.ok(
    forPerson("young-child").some(
      (warning) => warning.title === "Очень маленький возраст родителя",
    ),
  );
  assert.equal(forPerson("uncertain-child").length, 0);
  assert.ok(
    forPerson("old-child").some(
      (warning) => warning.title === "Необычно большой возраст родителя",
    ),
  );
  assert.equal(forPerson("posthumous-child").length, 0);
  assert.ok(
    forPerson("late-child").some(
      (warning) =>
        warning.title === "Ребёнок родился заметно позже смерти родителя",
    ),
  );
  assert.ok(
    forPerson("missing-parent-birth-child").some(
      (warning) =>
        warning.title === "Ребёнок родился заметно позже смерти родителя",
    ),
  );
  assert.ok(warnings.every((warning) => warning.detail.length > 0));
});

test("simultaneous living peak excludes people without a recorded birth", () => {
  const family: Family = {
    title: "Тест",
    description: "",
    demo: false,
    people: [
      person("dated-one", "Анна", "1900", 1, { death: "1950" }),
      person("dated-two", "Иван", "1910", 2, { death: "1960" }),
      person("undated-dead", "Мария", "", 3, { death: "1930" }),
      person("undated-living", "Пётр", "", 4),
    ],
  };
  const fact = analyzeFamilyInsights(family, 2026).facts.find(
    (item) => item.title === "Больше всего родственников жили одновременно",
  );
  assert.equal(fact?.value, "2");
  assert.match(fact?.detail || "", /1910 год/);

  const withoutBirths = analyzeFamilyInsights(
    { ...family, people: family.people.filter((item) => !item.birth) },
    2026,
  );
  assert.equal(
    withoutBirths.facts.some(
      (item) => item.title === "Больше всего родственников жили одновременно",
    ),
    false,
  );
});

test("overlapping generations exclude known deceased people without death dates", () => {
  const family: Family = { title: "Тест", description: "", demo: false, people: [
    person("dated-one", "Анна", "1850", 1, { death: "1920" }),
    person("dated-two", "Иван", "1900", 2, { death: "1970" }),
    person("marked", "Мария", "1850", 3, { deceased: true }),
    person("death-place", "Пётр", "1870", 4, { deathPlace: "Москва" }),
    person("unknown-birth", "Нина", "", 5, { deceased: true }),
  ] };
  const facts = analyzeFamilyInsights(family, 2026).facts;
  assert.equal(facts.find((fact) => fact.title === "Поколений одновременно")?.value, "2");
  assert.equal(facts.find((fact) => fact.title === "Больше всего родственников жили одновременно")?.value, "2");
  const onlyUnknownDeaths = analyzeFamilyInsights({ ...family,
    people: family.people.filter((item) => !item.death) }, 2026).facts;
  assert.ok(!onlyUnknownDeaths.some((fact) => fact.title === "Поколений одновременно"));
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
  }, 2026).facts;
  const men = facts.find(
    (fact) => fact.title === "Средняя продолжительность жизни мужчин за последние 100 лет",
  );
  const women = facts.find(
    (fact) => fact.title === "Средняя продолжительность жизни женщин за последние 100 лет",
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

test("recent lifespan uses the death period without excluding older birth cohorts", () => {
  const people = [
    person("historic", "Пётр", "1800", 1, { sex: "m", death: "1900" }),
    person("boundary", "Иван", "1866", 1, { sex: "m", death: "1926" }),
    person("recent", "Алексей", "1916", 1, { sex: "m", death: "2006" }),
    person("future", "Николай", "2000", 1, { sex: "m", death: "2070" }),
    person("living", "Сергей", "1930", 1, { sex: "m" }),
    person("unknown", "Михаил", "", 1, { sex: "m", death: "2000" }),
  ];
  const family: Family = { title: "Тест", description: "", demo: false, people };
  const men = analyzeFamilyInsights(family, 2026).facts.find((fact) =>
    fact.title === "Средняя продолжительность жизни мужчин за последние 100 лет");
  assert.equal(men?.value, "≈ 75 лет");
  assert.match(men?.detail || "", /^2 человека/);
  const nextYear = analyzeFamilyInsights(family, 2027).facts.find((fact) =>
    fact.title === men?.title);
  assert.equal(nextYear?.value, "≈ 90 лет", "the period advances with the current year");
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
