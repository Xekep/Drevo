import test from "node:test";
import assert from "node:assert/strict";
import type { Family, Person } from "../src/domain/types.ts";
import { treeDepthBranches } from "../src/domain/tree-depth.ts";

const p = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): Person => ({
  id,
  name: id,
  surname: "Тестов",
  patronymic: "",
  sex: "u",
  birth: "",
  birthPlace: "",
  parents,
  spouses,
  sources: [],
  generation: 1,
  column: 0,
});
const family: Family = {
  title: "Тест",
  description: "",
  demo: false,
  photos: [],
  unions: [],
  people: [
    p("grand"),
    p("dad", ["grand"], ["mom"]),
    p("mom", [], ["dad"]),
    p("me", ["dad", "mom"], ["partner"]),
    p("partner", ["partner-parent"], ["me"]),
    p("child", ["me", "partner"]),
    p("partner-parent"),
    p("sibling", ["dad", "mom"], ["sibling-partner"]),
    p("sibling-partner", [], ["sibling"]),
    p("nephew", ["sibling", "sibling-partner"]),
    p("isolate"),
  ],
  links: [{ id: "extra", from: "nephew", to: "isolate", type: "godparent" }],
};
const all = new Set(family.people.map((person) => person.id));

test("2.5D preserves an explicit civil partner without inventing marriage or opening that partner's ancestors", () => {
  const graph: Family = { ...family, people: [p("me"), p("partner", ["parent"]), p("parent")],
    unions: [{ id: "civil", participants: ["me", "partner"], type: "civil_union" }] };
  const before = structuredClone(graph);
  assert.deepEqual([...treeDepthBranches(graph, new Set(["me", "partner", "parent"]), "me").front], ["me", "partner"]);
  assert.deepEqual([...treeDepthBranches(graph, new Set(["me", "parent"]), "me").front], ["me"]);
  assert.deepEqual(graph, before);
});
test("2.5D exposes the anchor's direct lines and partners, keeping collateral branches behind", () => {
  const before = structuredClone(family);
  const view = treeDepthBranches(family, all, "me");
  assert.deepEqual(
    [...view.front].sort(),
    ["grand", "dad", "mom", "me", "partner", "child"].sort(),
  );
  assert.equal(view.back.length, 3);
  const sibling = view.back.find((branch) => branch.anchorId === "sibling")!;
  assert.deepEqual(
    [...sibling.members].sort(),
    ["sibling", "sibling-partner", "nephew"].sort(),
  );
  assert.deepEqual(family, before);
  assert.equal(
    [...view.front].length +
      view.back.reduce((sum, b) => sum + b.members.length, 0),
    all.size,
  );
});
test("selecting a back branch changes direct lines without opening descendants of every ancestor", () => {
  const next = treeDepthBranches(family, all, "sibling");
  assert.ok(next.front.has("nephew"));
  assert.ok(!next.front.has("me"));
  assert.ok(!next.front.has("child"));
  assert.ok(next.back.some((branch) => branch.members.includes("me")));
});
test("2.5D never exposes inaccessible people or uses extra links to merge genealogical branches", () => {
  const allowed = new Set(["me", "child", "sibling", "isolate"]);
  const view = treeDepthBranches(family, allowed, "me");
  assert.deepEqual([...view.front].sort(), ["me", "child"].sort());
  assert.deepEqual(view.back.map((b) => b.members).sort(), [
    ["isolate"],
    ["sibling"],
  ]);
  for (const id of [...view.front, ...view.back.flatMap((b) => b.members)])
    assert.ok(allowed.has(id));
});
test("unknown anchor, disconnected people and cyclic imported parents terminate deterministically", () => {
  assert.equal(treeDepthBranches(family, all, "missing").front.size, 0);
  const graph = {
    people: [p("a", ["b"]), p("b", ["a"]), p("outside")],
    links: [],
  };
  const first = treeDepthBranches(graph, new Set(["a", "b", "outside"]), "a");
  assert.deepEqual([...first.front], ["a", "b"]);
  assert.deepEqual(
    first,
    treeDepthBranches(graph, new Set(["a", "b", "outside"]), "a"),
  );
});
