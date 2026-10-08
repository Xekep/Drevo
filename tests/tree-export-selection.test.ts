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

test("blood export includes unmarried co-parents and explicit partners without their ancestors", () => {
  const data: Family = {
    ...family,
    people: family.people.map((p) => p.id === "child"
      ? { ...p, parents: ["root", "co-parent"] } : p).concat([
      person("co-parent", ["co-grandparent"]),
      person("co-grandparent"), person("co-sibling", ["co-grandparent"]),
      person("civil-partner", ["unrelated"]),
    ]),
    unions: [{ id: "civil", type: "civil_union", participants: ["root", "civil-partner"] }],
  };
  const before = structuredClone(data);
  const selected = treeExportPeople(data, "blood", "root");
  for (const id of ["child", "co-parent", "civil-partner"])
    assert.ok(selected.has(id), id);
  for (const id of ["co-grandparent", "co-sibling", "unrelated"])
    assert.equal(selected.has(id), false, id);
  assert.deepEqual(data, before);
});
