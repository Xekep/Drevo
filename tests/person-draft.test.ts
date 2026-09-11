import test from "node:test";
import assert from "node:assert/strict";
import { applyPersonDraft } from "../src/domain/person-draft.ts";
import type { Family, Person } from "../src/domain/types.ts";

const person = (id: string): Person => ({
  id,
  surname: "Тестов",
  name: id,
  patronymic: "",
  birth: "",
  birthPlace: "",
  sex: "u",
  parents: [],
  spouses: [],
  generation: 1,
  column: 0,
  sources: [],
});

test("person draft saves fields and staged parent, spouse and extra link removals together without mutating the archive", () => {
  const child = {
    ...person("child"),
    parents: ["father", "mother"],
    parentageComplete: true,
    spouses: ["spouse"],
  };
  const family: Family = {
    title: "Архив",
    description: "",
    demo: false,
    people: [
      person("father"),
      person("mother"),
      child,
      { ...person("spouse"), spouses: ["child"] },
    ],
    links: [
      { id: "godparent", from: "spouse", to: "child", type: "godparent" },
    ],
  };
  const before = structuredClone(family);
  const next = applyPersonDraft(
    family,
    {
      ...child,
      name: "Новое имя",
      birth: "1980-05-01",
      sources: [{ title: "Свидетельство", type: "", reference: "123" }],
    },
    [
      { from: "father", to: "child", type: "parent" },
      { from: "child", to: "spouse", type: "spouse" },
      { id: "godparent", from: "spouse", to: "child", type: "godparent" },
    ],
  );
  const saved = next.people.find((p) => p.id === "child")!;
  assert.equal(saved.name, "Новое имя");
  assert.equal(saved.birth, "1980-05-01");
  assert.equal(saved.sources[0].reference, "123");
  assert.deepEqual(saved.parents, ["mother"]);
  assert.equal(saved.parentageComplete, false);
  assert.deepEqual(saved.spouses, []);
  assert.deepEqual(next.people.find((p) => p.id === "spouse")!.spouses, []);
  assert.deepEqual(next.links, []);
  assert.deepEqual(family, before);
});

test("invalid draft still rejects contradictory dates when changing a relation", () => {
  const family: Family = {
    title: "Архив",
    description: "",
    demo: false,
    people: [person("a"), person("b")],
  };
  assert.throws(
    () =>
      applyPersonDraft(
        family,
        { ...family.people[0], birth: "2000", death: "1990" },
        [{ from: "a", to: "b", type: "spouse" }],
      ),
    /Некорректная карточка/,
  );
});

test("staged removals validate the final draft, allowing corrected dates after removing a wrong parent", () => {
  const child = {
    ...person("child"),
    birth: "1980",
    parents: ["father"],
    spouses: ["spouse"],
  };
  const family: Family = {
    title: "Архив",
    description: "",
    demo: false,
    people: [
      { ...person("father"), birth: "1950" },
      child,
      { ...person("spouse"), spouses: ["child"] },
    ],
  };
  const next = applyPersonDraft(family, { ...child, birth: "1940" }, [
    { from: "child", to: "spouse", type: "spouse" },
    { from: "father", to: "child", type: "parent" },
  ]);
  assert.equal(next.people[1].birth, "1940");
  assert.deepEqual(next.people[1].parents, []);
});
