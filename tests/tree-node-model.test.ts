import assert from "node:assert/strict";
import test from "node:test";
import type { Family, Person, TreeGeometry } from "../src/domain/index.ts";
import { buildTreeNodeModel } from "../src/components/tree/tree-node-model.ts";

function person(
  id: string,
  name: string,
  parents: string[] = [],
): Person {
  return {
    id,
    surname: "",
    name,
    patronymic: "",
    sex: "u",
    birth: "",
    birthPlace: "",
    parents,
    spouses: [],
    generation: 0,
    column: 0,
    sources: [],
  };
}

const people = [
  person("a", "Анна"),
  person("b", "Борис", ["a"]),
  person("c", "Вера", ["a"]),
];
const family: Family = {
  title: "Тест",
  description: "",
  demo: false,
  people,
  links: [],
};
const geometry: TreeGeometry = {
  mode: "generations",
  reverse: true,
  start: 1800,
  offset: 0,
  positions: [
    ["a:1", { x: 0, y: 0 }],
    ["a:2", { x: 240, y: 0 }],
    ["b:1", { x: 0, y: 140 }],
    ["c:1", { x: 240, y: 140 }],
  ],
  occurrences: [
    { id: "a:1", personId: "a", block: "family:1" },
    { id: "a:2", personId: "a", block: "family:2" },
    { id: "b:1", personId: "b", block: "family:1" },
    { id: "c:1", personId: "c", block: "family:2" },
  ],
  blocks: [
    {
      id: "family:1",
      members: ["a:1", "b:1"],
      x: 0,
      y: 0,
      width: 220,
      height: 236,
    },
  ],
  siblingGroups: [
    {
      id: "siblings:1",
      members: ["b:1", "c:1"],
      x: -10,
      y: 120,
      width: 480,
      height: 116,
    },
  ],
};
const growthLevels = new Map([
  ["a", 0],
  ["b", 1],
  ["c", 1],
]);

test("tree node model keeps occurrences, family state, backgrounds and query dimming", () => {
  const model = buildTreeNodeModel({
    family,
    geometry,
    mode: "generations",
    visible: new Set(["a", "b", "c"]),
    selected: ["a"],
    collapsed: new Set(["a"]),
    root: "a",
    hidden: new Map([["a", 2]]),
    expanded: new Set(["b"]),
    query: "Борис",
    growthLevels,
  });

  assert.equal(model.positions.get("b:1")?.y, 140);
  assert.deepEqual(model.personOccurrences.get("a"), ["a:1", "a:2"]);
  assert.equal(model.occurrencePeople.get("c:1"), "c");
  assert.equal(model.childrenCount.get("a"), 2);

  const anna = model.nodes.find((node) => node.id === "a:1")!;
  assert.equal(anna.selected, true);
  assert.equal(anna.data.occurrences, 2);
  assert.equal(anna.data.collapsed, true);
  assert.equal(anna.data.familyFocus, true);
  assert.equal(anna.data.anchor, true);
  assert.equal(anna.data.hiddenRelatives, 2);
  assert.equal(anna.data.childrenCount, 2);
  assert.equal(anna.data.household, true);
  assert.equal(anna.data.dimmed, true);
  assert.equal(anna.className, "tree-grow-node");
  assert.equal(
    (anna.style as Record<string, unknown>)["--tree-growth-delay"],
    "0ms",
  );

  const boris = model.nodes.find((node) => node.id === "b:1")!;
  assert.equal(boris.data.expanded, true);
  assert.equal(boris.data.household, true);
  assert.equal(boris.data.dimmed, false);
  assert.equal(
    (boris.style as Record<string, unknown>)["--tree-growth-delay"],
    "700ms",
  );
  assert.equal(model.maxGrowthLevel, 1);

  const household = model.displayNodes[0],
    siblings = model.displayNodes[1];
  assert.equal(household.id, "family:1");
  assert.equal(household.position.x, -8);
  assert.equal(siblings.id, "siblings:1");
  assert.equal(siblings.type, "household");
  if (siblings.type !== "household") assert.fail("Ожидался фоновый узел");
  assert.equal(siblings.data.label, "Дети · 2");
  assert.equal(siblings.data.reverse, true);
});

test("tree node model excludes hidden people and ignores geometry for another mode", () => {
  const hidden = buildTreeNodeModel({
    family,
    geometry,
    mode: "generations",
    visible: new Set(["a", "b"]),
    selected: [],
    collapsed: new Set(),
    root: null,
    hidden: new Map(),
    expanded: new Set(),
    query: "",
    growthLevels,
  });
  assert.deepEqual(
    hidden.nodes.map((node) => node.data.person.id),
    ["a", "a", "b"],
  );
  assert.equal(
    hidden.displayNodes.some((node) => node.id === "siblings:1"),
    false,
  );

  const otherMode = buildTreeNodeModel({
    family,
    geometry,
    mode: "timeline",
    visible: new Set(["a", "b", "c"]),
    selected: [],
    collapsed: new Set(),
    root: null,
    hidden: new Map(),
    expanded: new Set(),
    query: "",
    growthLevels,
  });
  assert.equal(otherMode.nodes.length, 0);
  assert.equal(otherMode.displayNodes.length, 0);
  assert.equal(otherMode.positions.size, 0);
});
