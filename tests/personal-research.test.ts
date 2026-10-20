import test from "node:test";
import assert from "node:assert/strict";
import { prepareTransactionUndo } from "../src/domain/transaction-undo.ts";
import {
  buildPeopleCriteria,
  peopleCriteriaRows,
} from "../src/domain/people-filter-builder.ts";
import { filterResearchPeople } from "../src/domain/research-people-filter.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, fields: Partial<Person> = {}): Person => ({
  id,
  surname: "Тестов",
  name: id,
  patronymic: "",
  sex: "u",
  birth: "1980",
  birthPlace: "Москва",
  parents: [],
  spouses: [],
  sources: [],
  generation: 1,
  column: 0,
  ...fields,
});
const family = (people: Person[]): Family => ({
  title: "Архив",
  description: "",
  demo: false,
  people,
  photos: [],
});

test("transaction undo preserves unrelated fields, people and subsequent changes", () => {
  const before = family([person("a"), person("b")]);
  const after = structuredClone(before);
  after.people[0].name = "Антон";
  after.people[1].biography = "Новая запись";
  const current = structuredClone(after);
  current.people[0].birth = "1981";
  current.people.push(person("c"));
  const reverted = prepareTransactionUndo(before, after, current).family;
  assert.equal(reverted.people[0].name, "a");
  assert.equal(reverted.people[0].birth, "1981");
  assert.equal(reverted.people[1].biography, undefined);
  assert.equal(reverted.people[2].id, "c");
  assert.equal(
    current.people[0].name,
    "Антон",
    "no mutation of the current snapshot",
  );
});

test("transaction undo rejects overlapping edits atomically and protects new dependencies", () => {
  const before = family([person("a")]);
  const after = structuredClone(before);
  after.people[0].name = "Антон";
  after.people[0].birth = "1982";
  const current = structuredClone(after);
  current.people[0].birth = "1983";
  assert.throws(
    () => prepareTransactionUndo(before, after, current),
    /изменились/,
  );
  assert.equal(current.people[0].name, "Антон");
  const created = family([person("a"), person("b")]);
  const dependent = structuredClone(created);
  dependent.people.push(person("c", { birth: "2000", parents: ["b"] }));
  assert.throws(
    () => prepareTransactionUndo(before, created, dependent),
    /зависимые связи/,
  );
  const edited = structuredClone(created);
  edited.people[1].biography = "Позднейшее исследование";
  assert.throws(
    () => prepareTransactionUndo(before, created, edited),
    /изменились/,
  );
});

test("builder round trips grouped conditions and uses existing genealogy filtering", () => {
  const criteria = buildPeopleCriteria(
    [
      { key: "a", field: "birthYearFrom", value: "1980" },
      { key: "b", field: "hasBirthDate", value: "true" },
      { key: "c", field: "deceased", value: "false" },
    ],
    "allOf",
  );
  const restored = peopleCriteriaRows(criteria);
  assert.deepEqual(buildPeopleCriteria(restored.rows, restored.mode), criteria);
  assert.deepEqual(
    filterResearchPeople(
      family([
        person("a"),
        person("b", { birth: "" }),
        person("c", { deceased: true }),
      ]),
      criteria,
      "include",
    ).personIds,
    ["a"],
  );
  const relatives = buildPeopleCriteria(
    [{ key: "a", field: "relation", value: "children", personId: "a" }],
    "allOf",
  );
  assert.deepEqual(
    filterResearchPeople(
      family([person("a"), person("b", { parents: ["a"] })]),
      relatives,
      "include",
    ).personIds,
    ["b"],
  );
  assert.throws(
    () =>
      buildPeopleCriteria(
        [{ key: "a", field: "birthYearFrom", value: "1.5" }],
        "allOf",
      ),
    /год/,
  );
  assert.throws(
    () =>
      buildPeopleCriteria(
        [{ key: "a", field: "relation", value: "children" }],
        "anyOf",
      ),
    /человека/,
  );
  assert.throws(() => buildPeopleCriteria([], "allOf"), /условий/);
});
