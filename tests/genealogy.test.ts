import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  analyzeKinship,
  ageLabel,
  fullName,
  safeUrl,
  validateFamily,
  type Person,
} from "../src/domain/index.ts";

const family = validateFamily(
  JSON.parse(
    readFileSync(new URL("./fixtures/family.json", import.meta.url), "utf8"),
  ),
);
const find = (id: string) => family.people.find((p) => p.id === id)!;
const relation = (a: string, b: string) =>
  analyzeKinship(find(a), find(b), family.people);

// A separate fixture covers both sides of a marriage, siblings and remarriage.
function extendedFamily() {
  const p = (
    id: string,
    sex: "m" | "f",
    parents: string[] = [],
    spouses: string[] = [],
  ): Person => ({ ...find("nikolai"), id, name: id, sex, parents, spouses });
  return [
    p("hf", "m"),
    p("hm", "f"),
    p("wf", "m"),
    p("wm", "f"),
    p("husband", "m", ["hf", "hm"], ["wife"]),
    p("wife", "f", ["wf", "wm"], ["husband"]),
    p("hb", "m", ["hf", "hm"], ["hbw"]),
    p("hs", "f", ["hf", "hm"], ["hsh"]),
    p("wb", "m", ["wf", "wm"], ["wbw"]),
    p("ws", "f", ["wf", "wm"], ["wsh"]),
    p("hbw", "f", [], ["hb"]),
    p("hsh", "m", [], ["hs"]),
    p("wbw", "f", [], ["wb"]),
    p("wsh", "m", [], ["ws"]),
    p("oldFather", "m"),
    p("mother", "f", [], ["newFather"]),
    p("newFather", "m", [], ["mother"]),
    p("otherMother", "f"),
    p("son", "m", ["oldFather", "mother"]),
    p("stepSon", "m", ["newFather", "otherMother"]),
    p("stepDaughter", "f", ["newFather", "otherMother"]),
    p("halfFather", "m", ["oldFather", "otherMother"]),
    p("halfMother", "f", ["newFather", "mother"]),
  ];
}
const extended = extendedFamily();
const expandedRelation = (a: string, b: string) =>
  analyzeKinship(
    extended.find((p) => p.id === a)!,
    extended.find((p) => p.id === b)!,
    extended,
  );

for (const [subject, reference, term] of [
  ["hm", "wife", "свекровь"],
  ["hf", "wife", "свёкор"],
  ["wm", "husband", "тёща"],
  ["wf", "husband", "тесть"],
  ["hb", "wife", "деверь"],
  ["hs", "wife", "золовка"],
  ["wb", "husband", "шурин"],
  ["ws", "husband", "свояченица"],
  ["wife", "hf", "невестка"],
  ["wife", "hm", "невестка"],
  ["husband", "wf", "зять"],
  ["husband", "wm", "зять"],
  ["hbw", "husband", "невестка"],
  ["hsh", "husband", "зять"],
  ["wsh", "husband", "свояк"],
  ["hbw", "wife", "невестка"],
  ["hsh", "wife", "зять"],
  ["wbw", "husband", "невестка"],
  ["hf", "wf", "сват"],
  ["hm", "wf", "сватья"],
  ["newFather", "son", "отчим"],
  ["mother", "stepSon", "мачеха"],
  ["son", "newFather", "пасынок"],
  ["stepDaughter", "mother", "падчерица"],
  ["stepSon", "son", "сводный брат"],
  ["stepDaughter", "son", "сводная сестра"],
  ["halfFather", "son", "единокровный брат"],
  ["halfMother", "son", "единоутробная сестра"],
  ["hb", "husband", "родной брат"],
  ["hs", "husband", "родная сестра"],
])
  test(`directional term: ${subject} → ${reference} = ${term}`, () => {
    assert.equal(expandedRelation(subject, reference).roles?.[0].term, term);
    assert.equal(expandedRelation(reference, subject).roles?.[1].term, term);
  });

test("incomplete parents do not invent a step-parent or step-sibling", () => {
  const data = extendedFamily();
  data.find((p) => p.id === "son")!.parents = ["mother"];
  const a = data.find((p) => p.id === "son")!,
    b = data.find((p) => p.id === "newFather")!,
    c = data.find((p) => p.id === "stepSon")!;
  assert.equal(analyzeKinship(b, a, data).roles?.[0].term, "муж матери");
  assert.equal(
    analyzeKinship(c, a, data).roles?.[0].term,
    "ребёнок супруга родителя",
  );
  a.parentageComplete = true;
  assert.equal(analyzeKinship(c, a, data).roles?.[0].term, "сводный брат");
});
test("explicitly incomplete parent lists do not assert half-sibling status", () => {
  const data = extendedFamily();
  const a = data.find((p) => p.id === "son")!,
    b = data.find((p) => p.id === "halfFather")!;
  a.parentageComplete = false;
  b.parentageComplete = false;
  const result = analyzeKinship(a, b, data);
  assert.equal(result.roles?.[0].term, "брат по отцу");
  assert.doesNotMatch(result.title, /Неполнородные/);
});
test("specific cousin and ancestor labels are shown in both directions", () => {
  assert.equal(relation("mikhail", "boris").roles?.[0].term, "двоюродный брат");
  assert.equal(
    relation("elena", "alexey").roles?.[0].term,
    "троюродная сестра",
  );
  assert.equal(relation("vera", "mikhail").roles?.[0].term, "тётя");
  assert.equal(relation("vera", "mikhail").roles?.[1].term, "племянник");
  assert.equal(relation("nikolai", "alexey").roles?.[0].term, "прадедушка");
  assert.equal(relation("nikolai", "alexey").roles?.[1].term, "правнук");
  assert.ok(
    expandedRelation("wife", "hf").roles?.[0].aliases?.includes("сноха"),
  );
  assert.ok(
    !expandedRelation("hbw", "husband").roles?.[0].aliases?.includes("сноха"),
  );
});

test("demo archive has 22 connected people across seven generations", () => {
  assert.equal(family.people.length, 22);
  assert.equal(Math.max(...family.people.map((p) => p.generation)), 7);
  for (const p of family.people)
    if (p.id !== "nikolai")
      assert.notEqual(relation("nikolai", p.id).kind, "unknown", fullName(p));
});
test("direct ancestor paths are directional and reversible", () => {
  const down = relation("nikolai", "sofia"),
    up = relation("sofia", "nikolai");
  assert.equal(down.kind, "direct");
  assert.equal(down.path.length, 7);
  assert.deepEqual(up.path, [...down.path].reverse());
  assert.deepEqual(down.distances, [0, 6]);
  assert.deepEqual(up.distances, [6, 0]);
  assert.match(relation("alexander-old", "mikhail").explanation, /отец/);
});
test("siblings, aunt, cousins and more distant cousins", () => {
  assert.equal(relation("alexander-old", "vera").title, "Брат и сестра");
  assert.equal(relation("vera", "mikhail").title, "Тётя и племянник");
  assert.equal(relation("mikhail", "boris").title, "Двоюродное родство");
  assert.equal(relation("alexey", "elena").title, "Троюродное родство");
  assert.deepEqual(relation("mikhail", "boris").common.sort(), [
    "maria",
    "nikolai",
  ]);
});
test("marriage and family-through-marriage are distinct from blood paths", () => {
  assert.equal(relation("mikhail", "anna").kind, "marriage");
  assert.equal(relation("anna", "alexander-old").kind, "family");
  assert.deepEqual(relation("anna", "alexander-old").path, [
    "anna",
    "mikhail",
    "alexander-old",
  ]);
});
test("unknown connections and same person do not create false kinship", () => {
  const lone = { ...find("anna"), id: "lone", parents: [], spouses: [] };
  assert.equal(
    analyzeKinship(find("nikolai"), lone, [...family.people, lone]).kind,
    "unknown",
  );
  assert.equal(relation("anna", "anna").title, "Один и тот же человек");
});
test("half siblings require distinct known second parents", () => {
  const a = { ...find("mikhail"), id: "a", parents: ["nikolai"] };
  const b = { ...find("anna"), id: "b", parents: ["nikolai"] };
  const list: Person[] = [
    find("nikolai"),
    find("maria"),
    find("elizaveta"),
    a,
    b,
  ];
  assert.equal(analyzeKinship(a, b, list).title, "Брат и сестра");
  a.parents.push("maria");
  b.parents.push("elizaveta");
  assert.match(analyzeKinship(a, b, list).title, /Неполнородные/);
});
test("dates calculate completed years at death", () => {
  assert.equal(ageLabel(find("alexander-old")), "71 год");
  assert.equal(
    ageLabel({ ...find("alexander-old"), death: "1942-03-13" }),
    "70 лет",
  );
});
test("archive validation rejects broken links, duplicate IDs and invalid dates", () => {
  const change = () => structuredClone(family);
  let data = change();
  data.people[0].spouses = ["missing"];
  assert.throws(() => validateFamily(data), /неизвестная/);
  data = change();
  data.people[1].id = data.people[0].id;
  assert.throws(() => validateFamily(data), /карточка/);
  data = change();
  data.people[0].birth = "1838-02-31";
  assert.throws(() => validateFamily(data), /карточка/);
  data = change();
  data.people[0].parents = ["sofia"];
  assert.throws(() => validateFamily(data));
});
test("unsafe photo and source schemes are omitted", () => {
  assert.equal(safeUrl("javascript:alert(1)"), undefined);
  assert.equal(safeUrl("//example.com"), undefined);
  assert.equal(safeUrl("/\\example.com"), undefined);
  assert.equal(safeUrl("data:text/html,hello"), undefined);
  assert.equal(
    safeUrl("/archive/family-notes.html#alexander"),
    "/archive/family-notes.html#alexander",
  );
  assert.equal(
    safeUrl("https://example.com/source"),
    "https://example.com/source",
  );
});

test("a shared child does not imply marriage", () => {
  const a = { ...find("nikolai"), id: "a", parents: [], spouses: [] };
  const b = { ...find("maria"), id: "b", parents: [], spouses: [] };
  const child = {
    ...find("mikhail"),
    id: "child",
    parents: ["a", "b"],
    spouses: [],
  };
  const result = analyzeKinship(a, b, [a, b, child]);
  assert.equal(result.kind, "family");
  assert.match(result.explanation, /брак не указан/);
  assert.doesNotMatch(result.explanation, /включает супружеские/);
});
test("direct ancestry wins when another shared ancestor gives a shorter path", () => {
  const p = (id: string, parents: string[]) => ({
    ...find("nikolai"),
    id,
    parents,
    spouses: [],
  });
  const grand = p("grand", []),
    a = p("a", ["grand"]),
    c = p("c", ["a"]),
    d = p("d", ["c"]),
    b = p("b", ["d", "grand"]);
  const result = analyzeKinship(a, b, [grand, a, b, c, d]);
  assert.equal(result.kind, "direct");
  assert.deepEqual(result.path, ["a", "c", "d", "b"]);
});
test("validation rejects future births, empty names and repeated parent edges", () => {
  let data = structuredClone(family);
  data.people[0].birth = "2099-01-01";
  assert.throws(() => validateFamily(data));
  data = structuredClone(family);
  data.people[0].name = " ";
  assert.throws(() => validateFamily(data));
  data = structuredClone(family);
  data.people[2].parents = ["nikolai", "nikolai"];
  assert.throws(() => validateFamily(data));
});
test("every reported chain uses real consecutive family links", () => {
  for (const a of family.people)
    for (const b of family.people) {
      const result = analyzeKinship(a, b, family.people);
      for (let i = 1; i < result.path.length; i++) {
        const prev = find(result.path[i - 1]),
          next = find(result.path[i]);
        assert.ok(
          prev.parents.includes(next.id) ||
            next.parents.includes(prev.id) ||
            prev.spouses.includes(next.id) ||
            next.spouses.includes(prev.id),
          `${a.id} → ${b.id}`,
        );
      }
    }
});
