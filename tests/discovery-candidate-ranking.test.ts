import assert from "node:assert/strict";
import test from "node:test";
import { candidateEvidence, candidateFuzzyTerms, candidateNameQuery,
  candidatePlaceQueries } from "../src/server/discovery-candidate-ranking.ts";

test("candidate lookup searches published birth surname and given name", () => {
  assert.equal(candidateNameQuery({ name: "Петрова Анна", birthSurname: "Иванова" }),
    "анна & (петрова | иванова)");
  assert.equal(candidateNameQuery({ name: "Анна" }), null);
  const match = candidateEvidence(
    { name: "Петрова Анна", birthSurname: "Иванова", birthYear: "1901", birthPlace: "Реж" },
    { name: "Иванова Анна", birthYear: "1901", birthPlace: "Рёж" },
  );
  assert.deepEqual(match?.reasons, [
    "Совпадают имя и фамилия при рождении", "Год рождения совпадает", "Место рождения совпадает",
  ]);
  assert.deepEqual(match?.conflicts, []);
  assert.equal(candidateEvidence({ name: "Петров Иван" }, { name: "Сидоров Иван" }), null);
});

test("a hyphenated published surname keeps the given name and both surname components", () => {
  const published = { name: "Иванова-Петрова Анна", birthYear: "1900" };
  assert.equal(candidateNameQuery(published), "анна & (иванова | петрова)");
  assert.deepEqual(candidateFuzzyTerms(published), {
    given: "анна", surnames: ["иванова", "петрова"],
  });
  assert.ok(candidateEvidence(published, { name: "Петрова Анна", birthYear: "1901" }),
    "the published second surname can support a candidate without exposing private fields");
});

test("published name components identify a multiword surname without a name dictionary", () => {
  const published = { name: "Де ла Крус Мария", surname: "Де ла Крус", givenName: "Мария" };
  assert.equal(candidateNameQuery(published), "мария & (де | ла | крус)");
  assert.ok(candidateEvidence(published, { name: "Крус Мария" })?.reasons
    .includes("Совпадает имя и часть составной фамилии"));
  assert.equal(candidateEvidence({ name: "Де ла Крус Мария" }, { name: "Крус Мария" }), null,
    "a legacy full name without its components cannot safely locate the boundary");
});

test("candidate evidence surfaces conflicting years without claiming identity", () => {
  const match = candidateEvidence(
    { name: "Тестов Иван", birthYear: "1890", deathYear: "1950" },
    { name: "Тестов Иван", birthYear: "1910", deathYear: "1970" },
  );
  assert.deepEqual(match?.conflicts, [
    "Год рождения различается: 1890 и 1910", "Год смерти различается: 1950 и 1970",
  ]);
});

test("one or two name typos produce a reason but common short names do not", () => {
  assert.deepEqual(candidateFuzzyTerms({ name: "Смирнова Екатерина", birthSurname: "Петрова" }),
    { given: "екатерина", surnames: ["смирнова", "петрова"] });
  assert.equal(candidateFuzzyTerms({ name: "Ли Ян" }), null);
  assert.match(candidateEvidence({ name: "Смирнова Екатерина" },
    { name: "Смирнава Екатерна" })!.reasons[0], /опечатка/);
  assert.equal(candidateEvidence({ name: "Смирнова Екатерина" },
    { name: "Сидорова Елизавета" }), null);
});

test("a matching given name and year alone do not suggest a changed surname", () => {
  const source = { name: "Иванова Анна", birthYear: "1900" };
  const candidate = { name: "Петрова Анна", birthYear: "1901" };
  assert.equal(candidateEvidence(source,candidate), null);
  assert.equal(candidateEvidence(source,candidate), null);
  assert.equal(candidateEvidence(source,{ ...candidate, birthYear: "1915" }), null);
});

test("partially matching published places are clues, distant places are conflicts", () => {
  const source = { name: "Иванов Иван", birthPlace: "г. Москва, область" };
  assert.ok(candidateEvidence(source,{ name: "Иванов Иван", birthPlace: "Москва" })!
    .reasons.some((reason) => reason.startsWith("Место рождения")));
  assert.deepEqual(candidateEvidence(source,{ name: "Иванов Иван", birthPlace: "Тверь" })!
    .conflicts,["Место рождения различается"]);
});

test("published place and year can find a changed surname without guessing identity", () => {
  const source = { name: "Иванова Анна", birthYear: "1900", birthPlace: "г. Москва" };
  assert.deepEqual(candidatePlaceQueries(source),
    [{ terms: "анна & москва", from: "1898", to: "1902" }]);
  const evidence = candidateEvidence(source,
    { name: "Петрова Анна", birthYear: "1901", birthPlace: "Москва" })!;
  assert.ok(evidence.reasons.includes("Место рождения совпадает"));
  assert.ok(evidence.conflicts.includes("Указанные фамилии различаются"));
  assert.deepEqual(candidatePlaceQueries({ name: "Иванова Анна", birthPlace: "Москва" }), []);
});

test("a shared country or region cannot stand in for a shared settlement", () => {
  const source = { name: "Иванова Анна", birthYear: "1900",
    birthPlace: "Россия, Свердловская область, Нижний Тагил" };
  assert.deepEqual(candidatePlaceQueries(source),
    [{ terms: "анна & нижний & тагил", from: "1898", to: "1902" }]);
  const unrelated = { name: "Петрова Анна", birthYear: "1901",
    birthPlace: "Россия, Свердловская область, Екатеринбург" };
  assert.equal(candidateEvidence(source,unrelated), null);
  assert.deepEqual(candidatePlaceQueries({ name: "Иванова Анна", birthYear: "1900",
    birthPlace: "Россия, Свердловская область" }), []);
  assert.deepEqual(candidatePlaceQueries({ name: "Шульц Анна", deathYear: "1945",
    deathPlace: "Кёнигсберг, Восточная Пруссия" }), [],
  "a death-year clue alone cannot satisfy the changed-surname birth-year evidence");
  assert.deepEqual(candidatePlaceQueries({ name: "Шульц Анна", birthYear: "1900",
    birthPlace: "Россия, Свердловская область", deathPlace: "д. Дубровка, Пермь" }),
  [{ terms: "анна & дубровка", from: "1898", to: "1902" }]);
});

test("both published settlements can independently retrieve a changed surname", () => {
  const source = { name: "Иванова Анна", birthYear: "1900",
    birthPlace: "Москва", deathPlace: "Казань" };
  assert.deepEqual(candidatePlaceQueries(source), [
    { terms: "анна & москва", from: "1898", to: "1902" },
    { terms: "анна & казань", from: "1898", to: "1902" },
  ]);
  assert.ok(candidateEvidence(source,{ name: "Петрова Анна", birthYear: "1901",
    deathPlace: "Казань" })!.reasons.includes("Место смерти совпадает"));
  assert.deepEqual(candidatePlaceQueries({ ...source, deathPlace: "Москва" }),
    [{ terms: "анна & москва", from: "1898", to: "1902" }],
  "the same locality needs only one indexed lookup");
});
