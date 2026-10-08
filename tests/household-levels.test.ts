import test from "node:test";
import assert from "node:assert/strict";
import { householdLevels } from "../src/domain/household-levels.ts";
import { person } from "./layout-fixtures.ts";

test("siblings remain peers when a partner has a longer recorded ancestry", () => {
  const people = [
    person("parent"),
    person("a", ["parent"], ["partner"]),
    person("b", ["parent"]),
    person("partner", ["partner-parent"], ["a"]),
    person("partner-parent", ["grandparent"]),
    person("grandparent", ["great"]),
    person("great"),
  ];
  const before = structuredClone(people);
  for (const input of [people, [...people].reverse()]) {
    const levels = householdLevels(input);
    assert.equal(levels.get("a"), 3);
    assert.equal(levels.get("b"), levels.get("a"));
    assert.equal(levels.get("partner"), levels.get("a"));
    assert.equal(levels.get("parent"), 2);
    for (const p of input)
      for (const parent of p.parents)
        assert.equal(levels.get(p.id)! - levels.get(parent)!, 1);
  }
  assert.deepEqual(people, before);
});

test("shorter parental branches align by kinship rather than sharing every founder floor", () => {
  const people = [
    person("great"),
    person("grand", ["great"]),
    person("father", ["grand"], ["mother"]),
    person("mother", ["maternal-parent"], ["father"]),
    person("maternal-parent"),
    person("child", ["father", "mother"]),
    person("separate"),
    person("separate-child", ["separate"]),
  ];
  const levels = householdLevels(people);
  assert.equal(levels.get("maternal-parent"), levels.get("grand"));
  assert.equal(levels.get("father"), 2);
  assert.equal(levels.get("mother"), 2);
  assert.equal(levels.get("child"), 3);
  assert.equal(levels.get("separate"), 0);
  assert.equal(levels.get("separate-child"), 1);
});

test("inconsistent ancestry keeps every parent before their child without forcing equality", () => {
  const people = [
    person("root"),
    person("child", ["root"]),
    person("grandchild", ["root", "child"]),
  ];
  const levels = householdLevels(people);
  for (const p of people)
    for (const parent of p.parents)
      assert.ok(levels.get(parent)! < levels.get(p.id)!);
  assert.equal(levels.get("grandchild"), 2);
});

test("deep relative generations remain iterative and ignore missing parent records", () => {
  const people = Array.from({ length: 10000 }, (_, i) =>
    person(`p-${i}`, i ? [`p-${i - 1}`] : ["missing"]),
  );
  const levels = householdLevels(people);
  assert.equal(levels.get("p-9999"), 9999);
  assert.equal(levels.size, people.length);
  assert.deepEqual([...householdLevels([])], []);
});
