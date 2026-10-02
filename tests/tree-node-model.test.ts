import assert from "node:assert/strict";
import test from "node:test";
import {
  adoptUserNodes,
  getNodesInside,
  Position,
  type InternalNodeBase,
} from "@xyflow/system";
import type { Family, Person, TreeGeometry } from "../src/domain/index.ts";
import { buildTreeNodeModel } from "../src/components/tree/tree-node-model.ts";

function person(id: string, name: string, parents: string[] = []): Person {
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
const growthDelays = new Map([
  ["a", 0],
  ["b", 640],
  ["c", 685],
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
    growthDelays,
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
    "640ms",
  );
  assert.equal(model.maxGrowthDelay, 685);

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
    growthDelays,
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
    growthDelays,
  });
  assert.equal(otherMode.nodes.length, 0);
  assert.equal(otherMode.displayNodes.length, 0);
  assert.equal(otherMode.positions.size, 0);
});

test("known public ports keep offscreen cards and surfaces culled before DOM measurement", () => {
  const model = buildTreeNodeModel({
    family,
    geometry: { ...geometry, nodeSize: { width: 280, height: 320 } },
    mode: "generations",
    visible: new Set(["a", "b", "c"]),
    selected: [],
    collapsed: new Set(),
    root: null,
    hidden: new Map(),
    expanded: new Set(),
    query: "",
    growthDelays,
  });
  const visibleId = model.nodes[0].id;
  const nodes = model.displayNodes.map((node, index) => ({
    ...node,
    position: node.id === visibleId
      ? { x: 20, y: 20 }
      : { x: 5000 + index * 400, y: 5000 },
  }));
  type ModelNode = (typeof nodes)[number];
  const lookup = new Map<string, InternalNodeBase<ModelNode>>();
  const parents = new Map<string, Map<string, InternalNodeBase<ModelNode>>>();
  const visible = () => getNodesInside(
    lookup,
    { x: 0, y: 0, width: 360, height: 400 },
    [0, 0, 1],
    true,
  ).map((node) => node.id);

  // No browser measurement has happened. Width/height alone did not prevent
  // React Flow's forceInitialRender from mounting the entire offscreen archive.
  adoptUserNodes(nodes, lookup, parents);
  assert.deepEqual(visible(), [visibleId]);
  for (const node of lookup.values()) {
    assert.equal(node.measured.width, undefined);
    assert.equal(node.measured.height, undefined);
    assert.ok(node.internals.handleBounds);
    if (node.type === "household")
      assert.deepEqual(node.internals.handleBounds, { source: [], target: [] });
  }

  const ports = lookup.get(visibleId)!.internals.handleBounds!;
  assert.deepEqual(ports.target, []);
  assert.ok(ports.source);
  assert.deepEqual(ports.source.map((handle) => ({
    id: handle.id,
    position: handle.position,
    nodeId: handle.nodeId,
    width: handle.width,
    height: handle.height,
    center: [handle.x + handle.width / 2, handle.y + handle.height / 2],
  })), [
    { id: "top", position: Position.Top, nodeId: visibleId, width: 12, height: 12, center: [140, 0] },
    { id: "bottom", position: Position.Bottom, nodeId: visibleId, width: 12, height: 12, center: [140, 320] },
    { id: "left", position: Position.Left, nodeId: visibleId, width: 12, height: 12, center: [0, 160] },
    { id: "right", position: Position.Right, nodeId: visibleId, width: 12, height: 12, center: [280, 160] },
  ]);

  // GPU handoff creates fresh user-node objects with hidden flags. A subsequent
  // native remount must preserve culling without requiring a measurement pass.
  adoptUserNodes(nodes.map((node) => ({ ...node, hidden: true })), lookup, parents);
  assert.deepEqual(visible(), []);
  adoptUserNodes(nodes.map((node) => ({ ...node, hidden: false })), lookup, parents);
  assert.deepEqual(visible(), [visibleId]);

  // Historical input illustrates the regression through the actual library API.
  adoptUserNodes(nodes.map((node) => ({ ...node, handles: undefined })), lookup, parents);
  assert.equal(visible().length, nodes.length);
});
