import assert from "node:assert/strict";
import test from "node:test";
import { treeExportPeople } from "../src/domain/tree-export-selection.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string, parents: string[] = [], spouses: string[] = []) =>
  ({
    id,
    parents,
    spouses,
    birth: "",
    name: id,
    surname: "",
    patronymic: "",
    sex: "u",
    birthPlace: "",
    generation: 1,
    column: 0,
    sources: [],
  }) as Person;
const family: Family = {
  title: "",
  description: "",
  demo: false,
  people: [
    person("grandmother", [], ["grandfather"]),
    person("grandfather", [], ["grandmother"]),
    person("mother", ["grandmother", "grandfather"], ["father"]),
    person("father", [], ["mother"]),
    person("root", ["mother", "father"], ["partner"]),
    person("sibling", ["mother", "father"]),
    person("partner", [], ["root"]),
    person("child", ["root", "partner"]),
    person("unrelated"),
  ],
};
const ids = (scope: Parameters<typeof treeExportPeople>[1], depth?: number) =>
  [...treeExportPeople(family, scope, "root", depth)].sort();

test("export scopes use recorded parentage, depth and authorized people", () => {
  assert.deepEqual(ids("ancestors", 1), ["root"]);
  assert.deepEqual(ids("ancestors", 2), ["father", "mother", "root"]);
  assert.deepEqual(ids("ancestors", 3), [
    "father",
    "grandfather",
    "grandmother",
    "mother",
    "root",
  ]);
  assert.deepEqual(ids("descendants", 2), ["child", "partner", "root"]);
  assert.ok(ids("family").includes("sibling"));
  assert.ok(ids("blood").includes("grandmother"));
  assert.ok(!ids("blood").includes("unrelated"));
  assert.equal(ids("all").length, family.people.length);
  assert.deepEqual([...treeExportPeople(family, "ancestors", "unknown")], []);
  const restricted = {
    ...family,
    people: family.people.filter((p) => p.id !== "grandmother"),
  };
  assert.ok(
    !treeExportPeople(restricted, "ancestors", "root", 5).has("grandmother"),
  );
});
