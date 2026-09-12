import assert from "node:assert/strict";
import test from "node:test";
import {
  connectionKey,
  type Family,
  type GraphConnection,
  type Person,
  type TreeGeometry,
} from "../src/domain/index.ts";
import { buildTreeEdges } from "../src/components/tree/tree-edge-adapter.ts";

function person(id: string): Person {
  return {
    id,
    surname: "",
    name: id,
    patronymic: "",
    sex: "u",
    birth: "",
    birthPlace: "",
    parents: [],
    spouses: [],
    generation: 0,
    column: 0,
    sources: [],
  };
}

const people = [person("a"), person("b"), person("c")];
const family: Family = {
  title: "Тест",
  description: "",
  demo: false,
  people,
  links: [],
};
const peopleMap = new Map(people.map((item) => [item.id, item]));
const basePositions = new Map([
  ["a", { x: 0, y: 0 }],
  ["b", { x: 0, y: 160 }],
  ["c", { x: 260, y: 0 }],
]);
const visible = new Set(["a", "b", "c"]);
const occurrencePeople = new Map(people.map((item) => [item.id, item.id]));
const growthLevels = new Map([
  ["a", 0],
  ["b", 1],
  ["c", 0],
]);
const parent: GraphConnection = {
  from: "a",
  to: "b",
  type: "parent",
  key: connectionKey({ from: "a", to: "b", type: "parent" }),
};
const godparent: GraphConnection = {
  id: "god-a-b",
  from: "a",
  to: "b",
  type: "godparent",
  key: connectionKey({
    id: "god-a-b",
    from: "a",
    to: "b",
    type: "godparent",
  }),
};
const geometry: TreeGeometry = {
  mode: "generations",
  reverse: false,
  positions: [...basePositions],
  start: 1800,
  offset: 0,
};

function baseInput() {
  return {
    family,
    user: null,
    mode: "generations" as const,
    geometry,
    connections: [parent, godparent],
    visible,
    positions: basePositions,
    occurrencePeople,
    peopleMap,
    highlighted: ["a", "b"],
    selectedEdge: undefined,
    canEdit: false,
    busy: false,
    extraVisible: false,
    preview: null,
    onEdge: () => {},
    onChoices: () => {},
    growthLevels,
  };
}

test("edge adapter preserves handles, highlighting, filters and draft preview", () => {
  const edges = buildTreeEdges(baseInput());
  assert.equal(edges.length, 1);
  assert.equal(edges[0].id, parent.key);
  assert.equal(edges[0].sourceHandle, "bottom");
  assert.equal(edges[0].targetHandle, "top");
  assert.equal(edges[0].style?.strokeWidth, 3);
  assert.ok(edges[0].markerEnd);
  assert.equal(edges[0].reconnectable, false);
  assert.equal(edges[0].className, "tree-grow-edge");
  assert.equal(
    (edges[0].style as Record<string, unknown>)["--tree-growth-delay"],
    "55ms",
  );

  const withExtras = buildTreeEdges({
    ...baseInput(),
    extraVisible: true,
    preview: { from: "b", to: "c" },
  });
  assert.deepEqual(
    withExtras.map((edge) => edge.id),
    [parent.key, godparent.key, "draft-preview"],
  );
  assert.ok(withExtras[1].markerEnd);
  assert.equal(withExtras[1].style?.strokeDasharray, "2 5");
  assert.equal(withExtras[2].type, "smoothstep");
});

test("family branch keeps real relations and delegates ambiguous selection", () => {
  const secondParent: GraphConnection = {
    from: "c",
    to: "b",
    type: "parent",
    key: connectionKey({ from: "c", to: "b", type: "parent" }),
  };
  const positions = new Map([
    ...basePositions,
    ["occ-a", { x: 80, y: 20 }],
    ["occ-b", { x: 80, y: 140 }],
  ]);
  const occurrences = new Map([
    ...occurrencePeople,
    ["occ-a", "a"],
    ["occ-b", "b"],
  ]);
  const branchGeometry: TreeGeometry = {
    ...geometry,
    positions: [...positions],
    branches: [
      {
        id: "child:family-a-b",
        source: "occ-a",
        target: "occ-b",
        union: "union:parents",
        relations: [
          { from: "a", to: "b", type: "parent" },
          { from: "c", to: "b", type: "parent" },
        ],
        route: {
          sourceHandle: "bottom",
          targetHandle: "top",
          points: [
            { x: 100, y: 100 },
            { x: 100, y: 130 },
          ],
        },
      },
    ],
  };
  let choices: GraphConnection[] = [];
  const edges = buildTreeEdges({
    ...baseInput(),
    geometry: branchGeometry,
    connections: [parent, secondParent],
    positions,
    occurrencePeople: occurrences,
    extraVisible: true,
    highlighted: [],
    onChoices: (value) => {
      choices = value;
    },
  });

  assert.equal(edges.length, 1);
  assert.equal(edges[0].id, "child:family-a-b");
  assert.equal(edges[0].data?.junction?.x, 100);
  edges[0].data!.onSelect(edges[0].data!.connection);
  assert.deepEqual(
    choices.map((edge) => edge.key),
    [parent.key, secondParent.key],
  );
});
