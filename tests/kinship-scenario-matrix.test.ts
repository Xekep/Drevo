import test from "node:test";
import assert from "node:assert/strict";
import { analyzeKinship } from "../src/domain/kinship-analysis.ts";
import { kinshipPerson as person } from "./fixtures/kinship-graphs.ts";
import type { Person } from "../src/domain/types.ts";

// These expectations follow the two explicit lineages, not another call to the analyzer.
for (const [depth, adjective] of [
  [2, "двоюродн"],
  [3, "троюродн"],
  [4, "четвероюродн"],
  [5, "пятиюродн"],
  [6, "шестиюродн"],
  [7, "семиюродн"],
  [8, "восьмиюродн"],
] as const)
  test(`${depth} levels to a shared ancestor: both sex-specific cousin roles and a spouse without blood kinship`, () => {
    const people: Person[] = [person("root", [], "m")];
    for (const branch of ["left", "right"])
      for (let level = 1; level <= depth; level++)
        people.push(
          person(
            `${branch}-${level}`,
            [level === 1 ? "root" : `${branch}-${level - 1}`],
            branch === "left" ? "m" : "f",
          ),
        );
    const a = people.find((item) => item.id === `left-${depth}`)!;
    const b = people.find((item) => item.id === `right-${depth}`)!;
    const spouse = { ...person("partner", [], "m"), spouses: [b.id] };
    b.spouses = [spouse.id];
    people.push(spouse);
    for (const archive of [people, [...people].reverse()]) {
      const relation = analyzeKinship(a, b, archive);
      assert.equal(relation.kind, "blood");
      assert.deepEqual(relation.distances, [depth, depth]);
      assert.equal(relation.roles?.[0].term, `${adjective}ый брат`);
      assert.equal(relation.roles?.[1].term, `${adjective}ая сестра`);
      assert.deepEqual(relation.common, ["root"]);
      assert.deepEqual(
        analyzeKinship(b, a, archive).roles,
        [...relation.roles!].reverse(),
      );
      const byMarriage = analyzeKinship(a, spouse, archive);
      assert.equal(byMarriage.kind, "family");
      assert.deepEqual(byMarriage.common, []);
      assert.equal(byMarriage.path.at(-2), b.id);
      assert.match(byMarriage.explanation, /Общий предок.*не найден/);
    }
  });

test("co-parents without a union are neither spouses nor blood relatives", () => {
  const a = person("father", [], "m"),
    b = person("mother", [], "f");
  const child = person("child", [a.id, b.id], "f");
  const relation = analyzeKinship(a, b, [a, b, child]);
  assert.equal(relation.kind, "family");
  assert.equal(relation.roles?.[0].term, "отец общего ребёнка");
  assert.equal(relation.roles?.[1].term, "мать общего ребёнка");
  assert.deepEqual(relation.common, []);
  assert.doesNotMatch(relation.explanation, /Цепочка включает супружеские/);
});

test("a nearer ancestor wins over a second, longer lineage and reverses with the endpoints", () => {
  const people = [
    person("root", [], "m"),
    person("x", ["root"], "f"),
    person("y", ["root"], "m"),
    person("z", ["y"], "f"),
    person("a", ["x", "z"], "m"),
    person("b", ["x"], "f"),
  ];
  const relation = analyzeKinship(people[4], people[5], people);
  assert.deepEqual(relation.distances, [1, 1]);
  assert.deepEqual(relation.common, ["x"]);
  assert.equal(relation.roles?.[0].term, "брат по матери");
  assert.deepEqual(
    analyzeKinship(people[5], people[4], people).path,
    [...relation.path].reverse(),
  );
});
