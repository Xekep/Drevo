import test from "node:test";
import assert from "node:assert/strict";
import { ancestorFanSlots } from "../src/domain/fan-chart.ts";
import type { Person } from "../src/domain/types.ts";

function person(
  id: string,
  sex: Person["sex"],
  parents: string[] = [],
): Person {
  return {
    id,
    surname: id,
    name: id,
    patronymic: "",
    sex,
    birth: "",
    birthPlace: "",
    parents,
    spouses: [],
    generation: 1,
    column: 0,
    sources: [],
  };
}

test("fan chart keeps father and mother in stable halves", () => {
  const people = [
    person("root", "u", ["mother", "father"]),
    person("father", "m", ["grandmother"]),
    person("mother", "f"),
    person("grandmother", "f"),
  ];
  const slots = ancestorFanSlots(people, "root", 3);

  assert.deepEqual(
    slots.map((slot) => [slot.generation, slot.index, slot.personId]),
    [
      [0, 0, "root"],
      [1, 0, "father"],
      [1, 1, "mother"],
      [2, 0, null],
      [2, 1, "grandmother"],
      [2, 2, null],
      [2, 3, null],
    ],
  );
});

test("fan chart preserves missing parental slots instead of shifting branches", () => {
  const people = [person("root", "u", ["mother"]), person("mother", "f")];
  const slots = ancestorFanSlots(people, "root", 2);

  assert.deepEqual(
    slots.filter((slot) => slot.generation === 1).map((slot) => slot.personId),
    [null, "mother"],
  );
});

test("pedigree collapse stays visible as repeated fan positions", () => {
  const people = [
    person("root", "u", ["father", "mother"]),
    person("father", "m", ["shared"]),
    person("mother", "f", ["shared"]),
    person("shared", "u"),
  ];
  const slots = ancestorFanSlots(people, "root", 3);

  assert.equal(
    slots.filter((slot) => slot.generation === 2 && slot.personId === "shared")
      .length,
    2,
  );
});

test("missing fan root is safe", () => {
  assert.deepEqual(ancestorFanSlots([person("a", "u")], "missing", 5), []);
});
