import assert from "node:assert/strict";
import test from "node:test";
import { candidateEvidence, candidateFuzzyTerms, candidateNameQuery,
  candidatePlaceQuery, candidateRelativeQuery } from "../src/server/discovery-candidate-ranking.ts";

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

test("only published relative names can support a suggestion and never appear in its reason", () => {
  const relatives = [{ kind: "parent" as const, name: "Тестов Пётр" }];
  assert.equal(candidateRelativeQuery(relatives), "(петр & тестов)");
  const source = { name: "Иванова Анна", birthYear: "1900" };
  const candidate = { name: "Петрова Анна", birthYear: "1901" };
  assert.equal(candidateEvidence(source,candidate), null);
  const evidence = candidateEvidence(source,candidate,relatives,relatives)!;
  assert.ok(evidence.reasons.includes("Совпадает опубликованный близкий родственник"));
  assert.doesNotMatch(JSON.stringify(evidence), /Пётр|Тестов/);
  assert.equal(candidateEvidence(source,{ ...candidate, birthYear: "1915" },relatives,relatives), null);
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
  assert.deepEqual(candidatePlaceQuery(source),
    { terms: "анна & москва", column: "birth_year", from: "1898", to: "1902" });
  const evidence = candidateEvidence(source,
    { name: "Петрова Анна", birthYear: "1901", birthPlace: "Москва" })!;
  assert.ok(evidence.reasons.includes("Место рождения совпадает"));
  assert.ok(evidence.conflicts.includes("Указанные фамилии различаются"));
  assert.equal(candidatePlaceQuery({ name: "Иванова Анна", birthPlace: "Москва" }), null);
});

test("a shared country or region cannot stand in for a shared settlement", () => {
  const source = { name: "Иванова Анна", birthYear: "1900",
    birthPlace: "Россия, Свердловская область, Нижний Тагил" };
  assert.deepEqual(candidatePlaceQuery(source),
    { terms: "анна & нижний & тагил", column: "birth_year", from: "1898", to: "1902" });
  const unrelated = { name: "Петрова Анна", birthYear: "1901",
    birthPlace: "Россия, Свердловская область, Екатеринбург" };
  assert.equal(candidateEvidence(source,unrelated), null);
  assert.equal(candidatePlaceQuery({ name: "Иванова Анна", birthYear: "1900",
    birthPlace: "Россия, Свердловская область" }), null);
  assert.deepEqual(candidatePlaceQuery({ name: "Шульц Анна", deathYear: "1945",
    deathPlace: "Кёнигсберг, Восточная Пруссия" }),
  { terms: "анна & кенигсберг", column: "death_year", from: "1943", to: "1947" });
  assert.deepEqual(candidatePlaceQuery({ name: "Шульц Анна", deathYear: "1945",
    deathPlace: "д. Дубровка, Пермь" }),
  { terms: "анна & дубровка", column: "death_year", from: "1943", to: "1947" });
});
