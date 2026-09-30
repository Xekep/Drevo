import assert from "node:assert/strict";
import test from "node:test";
import { candidateEvidence, candidateNameQuery } from "../src/server/discovery-candidate-ranking.ts";

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
