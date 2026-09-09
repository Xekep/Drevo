import test from "node:test";
import assert from "node:assert/strict";
import {
  directoryPeople,
  directoryYears,
} from "../src/domain/people-directory.ts";
import {
  relativeAtHandle,
  initialFamilyFocus,
} from "../src/domain/tree-interactions.ts";
import type { Person } from "../src/domain/types.ts";
const p = (id: string, birth = ""): Person => ({
  id,
  name: "Анна",
  surname: id,
  patronymic: "",
  sex: "f",
  birth,
  birthPlace: "",
  parents: [],
  spouses: [],
  sources: [],
  column: 0,
  generation: 1,
});
test("people sorting puts missing dates last in both directions and preserves original ordering", () => {
  const people = [
      p("Яковлева", "1980"),
      p("Андреева"),
      { ...p("Борисова", "1920"), maidenName: "Соколова" },
    ],
    before = structuredClone(people);
  assert.deepEqual(
    directoryPeople(people, "", "birth").map((p) => p.id),
    ["Борисова", "Яковлева", "Андреева"],
  );
  assert.deepEqual(
    directoryPeople(people, "", "birth-desc").map((p) => p.id),
    ["Яковлева", "Борисова", "Андреева"],
  );
  assert.equal(directoryPeople(people, "соколова", "name")[0].id, "Борисова");
  assert.equal(directoryYears(people[0]), "Род. 1980");
  assert.equal(directoryYears(people[1]), "");
  assert.equal(directoryYears({ ...people[0], death: "2020" }), "1980 — 2020");
  assert.deepEqual(people, before);
});
test("empty-space creation respects reversed generations and mobile opening includes a connected household", () => {
  assert.equal(relativeAtHandle("top", false), "parent");
  assert.equal(relativeAtHandle("top", true), "child");
  assert.equal(relativeAtHandle("bottom", true), "parent");
  assert.equal(relativeAtHandle("right", true), "spouse");
  const people = [
    p("a"),
    { ...p("b"), spouses: ["a"] },
    { ...p("child"), parents: ["a", "b"] },
    p("unrelated"),
  ];
  assert.deepEqual(
    new Set(initialFamilyFocus(people)),
    new Set(["a", "b", "child"]),
  );
});
