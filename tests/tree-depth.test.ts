import test from "node:test";
import assert from "node:assert/strict";
import type { Family, Person } from "../src/domain/types.ts";
import { treeDepthBranches } from "../src/domain/tree-depth.ts";
import {
  depthWorld,
  depthCamera,
  projectDepth,
  interpolateDepthCamera,
  depthLabelMarkers,
  depthContextOffsets,
} from "../src/domain/tree-depth-scene.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

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
  const graph: Family = {
    ...family,
    people: [p("me"), p("partner", ["parent"]), p("parent")],
    unions: [
      { id: "civil", participants: ["me", "partner"], type: "civil_union" },
    ],
  };
  const before = structuredClone(graph);
  assert.deepEqual(
    [
      ...treeDepthBranches(graph, new Set(["me", "partner", "parent"]), "me")
        .front,
    ],
    ["me", "partner"],
  );
  assert.deepEqual(
    [...treeDepthBranches(graph, new Set(["me", "parent"]), "me").front],
    ["me"],
  );
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
  assert.ok(
    sibling.connections.some(
      (edge) =>
        edge.from === "dad" && edge.to === "sibling" && edge.type === "parent",
    ),
  );
  assert.ok(
    sibling.connections.some(
      (edge) => edge.from === "mom" && edge.to === "sibling",
    ),
  );
  assert.deepEqual(
    view.back.find((branch) => branch.anchorId === "isolate")!.connections,
    [],
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
  for (const edge of view.back.flatMap((branch) => branch.connections)) {
    assert.ok(allowed.has(edge.from));
    assert.ok(allowed.has(edge.to));
  }
});

function fixtureGeometry(people: Person[], reverse = false): TreeGeometry {
  const levels = new Map<string, number>();
  for (let i = 0; i < people.length; i++)
    for (const p of people)
      levels.set(
        p.id,
        Math.max(0, ...p.parents.map((id) => (levels.get(id) || 0) + 1)),
      );
  const rows = new Map<number, number>();
  return {
    mode: "generations",
    reverse,
    start: 0,
    offset: 0,
    nodeSize: { width: 220, height: 264 },
    positions: people.map((p) => {
      const y = levels.get(p.id) || 0,
        x = rows.get(y) || 0;
      rows.set(y, x + 1);
      return [p.id, { x: x * 400, y: y * 400 * (reverse ? -1 : 1) }];
    }),
  };
}
function fixtureWorld(graph = family, reverse = false) {
  const allowed = new Set(graph.people.map((p) => p.id));
  const view = treeDepthBranches(graph, allowed, "me"),
    geometry = fixtureGeometry(graph.people, reverse);
  return depthWorld(
    view.back,
    new Map(graph.people.map((p) => [p.id, p])),
    geometry,
    "me",
    graph.unions,
  );
}

test("one stable spatial world keeps generation coordinates and actual family hinges", () => {
  const before = structuredClone(family),
    world = fixtureWorld();
  assert.equal(world.points.size, family.people.length);
  for (const [id, p] of world.points) assert.equal(p.y, world.flat.get(id)!.y);
  const plane = world.planeOf.get("sibling")!;
  assert.deepEqual(plane.attachment.sort(), ["dad", "mom"]);
  assert.equal(world.planeOf.get("nephew"), plane);
  assert.notEqual(world.points.get("sibling")!.z, 0);
  assert.equal(world.planeOf.get("isolate")!.attachment.length, 0);
  assert.ok(
    !world.connections.some(
      (edge) => edge.to === "isolate" || edge.from === "isolate",
    ),
  );
  assert.deepEqual(family, before);
});

test("choosing another family rotates the whole scene without recomputing or replacing world points", () => {
  const world = fixtureWorld(),
    saved = structuredClone(world.points);
  const start = depthCamera(world, "me"),
    target = depthCamera(world, "sibling");
  const oldDad = projectDepth(world.points.get("dad")!, start);
  const newDad = projectDepth(world.points.get("dad")!, target);
  assert.ok(oldDad.x !== newDad.x || oldDad.y !== newDad.y);
  const selected = projectDepth(world.points.get("sibling")!, target);
  assert.equal(selected.x, world.flat.get("sibling")!.x);
  assert.equal(selected.y, world.flat.get("sibling")!.y);
  assert.equal(selected.scale, 1);
  const sibling = projectDepth(world.points.get("sibling")!, target),
    nephew = projectDepth(world.points.get("nephew")!, target);
  assert.ok(nephew.y > sibling.y);
  assert.ok(
    Math.abs(nephew.scale - 1) < 0.001,
    "the selected plane faces the viewer",
  );
  for (let t = 0; t <= 1; t += 0.1)
    for (const point of world.points.values()) {
      const p = projectDepth(point, interpolateDepthCamera(start, target, t));
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y) && p.scale > 0);
    }
  assert.deepEqual(world.points, saved);
  assert.deepEqual(
    projectDepth(world.points.get("me")!, depthCamera(world, "me")),
    projectDepth(world.points.get("me")!, start),
  );
});

test("camera interpolation is continuous and reverses exactly, with no scale/roll deformation", () => {
  const world = fixtureWorld(),
    a = depthCamera(world, "me"),
    b = depthCamera(world, "nephew");
  assert.deepEqual(interpolateDepthCamera(a, b, 0), a);
  assert.deepEqual(interpolateDepthCamera(a, b, 1), b);
  const halfway = interpolateDepthCamera(a, b, 0.5);
  assert.deepEqual(halfway, interpolateDepthCamera(b, a, 0.5));
  assert.equal(halfway.target.z, (a.target.z + b.target.z) / 2);
  assert.equal(projectDepth(b.target, b).scale, 1);
});

test("spatial topology retains multiple partners and repeated ancestors as one person each", () => {
  const graph: Family = {
    ...family,
    links: [],
    people: [
      p("me", ["dad", "mom"], ["one", "two"]),
      p("dad", ["grand"]),
      p("mom", ["grand"]),
      p("grand"),
      p("one"),
      p("two"),
      p("child-one", ["me", "one"]),
      p("child-two", ["me", "two"]),
    ],
    unions: [
      { id: "civil", participants: ["one", "two"], type: "civil_union" },
    ],
  };
  const world = fixtureWorld(graph);
  assert.equal(world.points.size, graph.people.length);
  for (const child of ["child-one", "child-two"]) {
    const parents = world.connections
      .filter((edge) => edge.type === "parent" && edge.to === child)
      .map((e) => e.from)
      .sort();
    assert.deepEqual(
      parents,
      child === "child-one" ? ["me", "one"] : ["me", "two"],
    );
  }
  assert.equal(
    world.connections.filter((e) => e.type === "parent" && e.from === "grand")
      .length,
    2,
  );
  assert.equal(
    world.connections.filter(
      (e) => e.type === "partner" && [e.from, e.to].sort().join() === "one,two",
    ).length,
    1,
  );
});

test("large branches keep their geometry instead of replacing an eighteen-person preview on selection", () => {
  const graph: Family = {
    ...family,
    links: [],
    unions: [],
    people: [
      p("dad"),
      p("me", ["dad"]),
      p("sibling", ["dad"]),
      ...Array.from({ length: 80 }, (_, i) => p(`child-${i}`, ["sibling"])),
    ],
  };
  const world = fixtureWorld(graph);
  assert.equal(world.points.size, 83);
  assert.equal(world.planeOf.get("sibling")!.members.length, 81);
  const a = world.points.get("child-79")!;
  assert.ok(Number.isFinite(projectDepth(a, depthCamera(world, "child-79")).x));
});

test("world projection respects reversed generations and never restores inaccessible geometry IDs", () => {
  const reversed = fixtureWorld(family, true),
    camera = depthCamera(reversed, "sibling");
  assert.ok(
    projectDepth(reversed.points.get("nephew")!, camera).y <
      projectDepth(reversed.points.get("sibling")!, camera).y,
  );
  const allowed = new Set(["me", "child", "sibling"]),
    view = treeDepthBranches(family, allowed, "me");
  const people = new Map(
    family.people.filter((p) => allowed.has(p.id)).map((p) => [p.id, p]),
  );
  const scopedGeometry = fixtureGeometry(
    family.people.filter((p) => allowed.has(p.id)),
  );
  scopedGeometry.positions.push(["private-id", { x: 0, y: 0 }]);
  const world = depthWorld(
    view.back,
    people,
    scopedGeometry,
    "me",
    family.unions,
  );
  assert.deepEqual([...world.points.keys()].sort(), [...allowed].sort());
  for (const edge of world.connections)
    assert.ok(allowed.has(edge.from) && allowed.has(edge.to));
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

test("context labels never cover another person's minimum target or change their world positions", () => {
  const cards = [
    { id: "front", x: 0, y: 0, scale: 0.55, full: true },
    { id: "sibling", x: 160, y: 0, scale: 0.75, full: false },
    { id: "aunt", x: 275, y: 0, scale: 0.75, full: false },
    { id: "clear", x: 500, y: 0, scale: 0.75, full: false },
  ];
  const before = structuredClone(cards),
    markers = depthLabelMarkers(cards);
  assert.ok(markers.has("sibling") || markers.has("aunt"));
  assert.ok(!markers.has("front") && !markers.has("clear"));
  assert.deepEqual(cards, before);
});

test("mobile overview separates context hit targets with leaders, keeping full cards and world positions fixed", () => {
  const cards = [
    { id: "me", x: 240, y: 300, scale: 0.55, full: true },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: `branch-${i}`,
      x: 95 + i * 12,
      y: 300,
      scale: 0.75,
      full: false,
    })),
  ];
  const before = structuredClone(cards),
    offsets = depthContextOffsets(cards, 390, 700);
  assert.deepEqual(offsets.get("me"), { x: 0, y: 0 });
  const labels = cards
    .slice(1)
    .map((card) => ({
      x: card.x + offsets.get(card.id)!.x,
      y: card.y + offsets.get(card.id)!.y,
    }));
  for (let i = 0; i < labels.length; i++) {
    assert.ok(
      labels[i].x >= 25 &&
        labels[i].x <= 365 &&
        labels[i].y >= 25 &&
        labels[i].y <= 675,
    );
    for (let j = i + 1; j < labels.length; j++)
      assert.ok(
        Math.abs(labels[i].x - labels[j].x) >= 50.9 ||
          Math.abs(labels[i].y - labels[j].y) >= 50.9,
        `overlapping context targets: ${i},${j}`,
      );
  }
  assert.ok(
    [...offsets.values()].some((offset) => Math.hypot(offset.x, offset.y) > 10),
  );
  assert.deepEqual(cards, before);
});
