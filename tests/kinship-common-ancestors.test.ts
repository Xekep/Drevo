import test from "node:test";
import assert from "node:assert/strict";
import { analyzeKinship, type Person } from "../src/domain/index.ts";

const person = (
  id: string,
  name: string,
  sex: Person["sex"],
  parents: string[] = [],
): Person => ({
  id,
  name,
  surname: "Тестов",
  patronymic: "",
  sex,
  birth: "",
  birthPlace: "",
  parents,
  parentageComplete: parents.length >= 2,
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
});

test("прямая линия не называет родителя общим предком", () => {
  const father = person("father", "Александр", "m");
  const child = person("child", "Иван", "m", [father.id]);
  const relation = analyzeKinship(father, child, [father, child]);

  assert.equal(relation.kind, "direct");
  assert.deepEqual(relation.common, []);
  assert.doesNotMatch(relation.explanation, /общ(ий|ие) пред/iu);
  assert.match(relation.explanation, /отец/iu);
});

test("равноудалённые отец и мать оба показываются общими предками", () => {
  const father = person("father", "Александр", "m");
  const mother = {
    ...person("mother", "Мария", "f"),
    surname: "Тестова",
  };
  const son = person("son", "Иван", "m", [father.id, mother.id]);
  const daughter = person("daughter", "Анна", "f", [father.id, mother.id]);
  const relation = analyzeKinship(son, daughter, [father, mother, son, daughter]);

  assert.equal(relation.kind, "blood");
  assert.deepEqual(new Set(relation.common), new Set([father.id, mother.id]));
  assert.match(relation.explanation, /^Общие предки —/u);
  assert.match(relation.explanation, /Тестов Александр/u);
  assert.match(relation.explanation, /Тестова Мария/u);
});
