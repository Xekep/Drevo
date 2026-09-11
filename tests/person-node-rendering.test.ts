import test from "node:test";
import assert from "node:assert/strict";
import { samePersonNodeData } from "../src/components/tree/person-node-data.ts";
import type { Person } from "../src/domain/types.ts";

const person: Person = {
  id: "p1",
  surname: "Тестов",
  name: "Иван",
  patronymic: "Иванович",
  sex: "m",
  birth: "1950",
  birthPlace: "",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
};

const data = () => ({
  person,
  collapsed: false,
  childrenCount: 2,
  dimmed: false,
  household: true,
  occurrences: 1,
  familyFocus: false,
  anchor: false,
  hiddenRelatives: 0,
  expanded: false,
});

test("person node keeps memo equality for a recreated but unchanged data wrapper", () => {
  assert.equal(samePersonNodeData(data(), data()), true);
});

test("person node invalidates memo when visible card state changes", () => {
  const first = data(),
    selectedBySearch = { ...data(), dimmed: true },
    changedPerson = { ...data(), person: { ...person, name: "Пётр" } };
  assert.equal(samePersonNodeData(first, selectedBySearch), false);
  assert.equal(samePersonNodeData(first, changedPerson), false);
});
