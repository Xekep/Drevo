import test from "node:test";
import assert from "node:assert/strict";
import { suggestConnectionOrder, type Person } from "../src/domain/index.ts";
const p = (
  id: string,
  sex: Person["sex"] = "m",
  parents: string[] = [],
  birth = "",
): Person => ({
  id,
  name: id,
  surname: "Тест",
  patronymic: "",
  sex,
  parents,
  birth,
  birthPlace: "",
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  createdBy: "r",
});

test("initial parent direction uses non-overlapping date ranges and preserves other relation types", () => {
  const people = [p("a", "m", [], "2000-05-03"), p("b", "f", [], "1970")];
  const draft = { from: "a", to: "b", type: "parent" as const };
  const ordered = suggestConnectionOrder(draft, people);
  assert.equal(ordered.from, "b");
  assert.equal(ordered.to, "a");
  assert.match(ordered.hint!, /датам рождения/);
  assert.deepEqual(draft, { from: "a", to: "b", type: "parent" });
  for (const type of ["spouse", "godparent"] as const) {
    const other = { ...draft, type };
    assert.equal(suggestConnectionOrder(other, people), other);
  }
  for (const [a, b] of [
    ["", "1970"],
    ["1970", "1970-06-01"],
    ["1970-06", "1970-06-03"],
    ["1970-06-03", "1970-06-03"],
  ]) {
    assert.deepEqual(
      suggestConnectionOrder(draft, [p("a", "m", [], a), p("b", "m", [], b)]),
      draft,
    );
  }
  assert.equal(
    suggestConnectionOrder(draft, [
      p("a", "m", [], "1970-06-04"),
      p("b", "m", [], "1970-06-03"),
    ]).from,
    "b",
  );
});
