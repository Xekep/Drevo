import test from "node:test";
import assert from "node:assert/strict";
import type { Family, Person } from "../src/domain/types.ts";
import { treeDepthBranches } from "../src/domain/tree-depth.ts";
import {
  spatialWorld,
  spatialCardFloor,
  spatialCardLimit,
} from "../src/domain/tree-spatial.ts";
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

test("3D preserves an explicit civil partner without inventing marriage or opening that partner's ancestors", () => {
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
test("3D exposes the anchor's direct lines and partners, keeping collateral branches behind", () => {
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
test("3D never exposes inaccessible people or uses extra links to merge genealogical branches", () => {
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

test("3D retains exact topology, repeated ancestors and civil partners without duplicate edges", () => {
  const graph = {
    ...family,
    unions: [
      {
        id: "civil",
        participants: ["me", "partner"] as [string, string],
        type: "civil_union" as const,
      },
    ],
  };
  const before = structuredClone(graph);
  const world = spatialWorld(
    new Map(graph.people.map((p) => [p.id, p])),
    fixtureGeometry(graph.people),
    graph.unions,
  );
  assert.equal(world.points.size, graph.people.length);
  const partners = world.connections.filter(
    (e) => e.type === "partner" && [e.from, e.to].includes("me"),
  );
  assert.equal(partners.length, 1);
  assert.equal(
    world.connections.filter((e) => e.to === "child" && e.type === "parent")
      .length,
    2,
  );
  assert.equal(
    world.connections.filter((e) => e.to === "isolate" || e.from === "isolate")
      .length,
    0,
  );
  assert.deepEqual(graph, before);
});

test("3D has real depth and keeps ordered generations in either direction", () => {
  for (const reverse of [false, true]) {
    const geometry = fixtureGeometry(family.people, reverse);
    const world = spatialWorld(
      new Map(family.people.map((p) => [p.id, p])),
      geometry,
    );
    assert.ok(new Set([...world.points.values()].map((p) => p.z)).size > 2);
    assert.ok(
      (world.points.get("dad")!.y - world.points.get("me")!.y) *
        (reverse ? -1 : 1) >
        0,
    );
    for (const point of world.points.values())
      assert.ok(Object.values(point).every(Number.isFinite));
    assert.deepEqual(
      spatialWorld(new Map(family.people.map((p) => [p.id, p])), geometry),
      world,
    );
  }
});

test("single-child 3D lines remain vertical without accumulating depth over generations", () => {
  const people = Array.from({ length: 40 }, (_, i) => p(String(i), i ? [String(i - 1)] : []));
  for (const reverse of [false, true]) {
    const geometry = fixtureGeometry(people, reverse);
    const before = structuredClone(geometry);
    const world = spatialWorld(new Map(people.map(person => [person.id, person])), geometry);
    const root = world.points.get("0")!;
    for (let i = 1; i < people.length; i++) {
      const point = world.points.get(String(i))!;
      assert.equal(point.x, root.x);
      assert.equal(point.z, root.z);
      assert.equal(point.y - root.y, -i * 400 * (reverse ? -1 : 1));
    }
    assert.equal(world.connections.length, 39);
    assert.deepEqual(geometry, before);
  }
});

test("3D forks separate around the family axis and their unary continuations keep that axis", () => {
  const people = [p("a", [], ["b"]), p("b", [], ["a"]),
    p("c", ["a", "b"]), p("d", ["a", "b"]), p("e", ["c"]), p("f", ["d"])];
  const world = spatialWorld(new Map(people.map(person => [person.id, person])), fixtureGeometry(people));
  const [a, b, c, d, e, f] = ["a", "b", "c", "d", "e", "f"].map(id => world.points.get(id)!);
  for (const axis of ["x", "z"] as const) {
    assert.ok(Math.abs((c[axis] + d[axis] - a[axis] - b[axis]) / 2) < 1e-8);
    assert.equal(e[axis], c[axis]);
    assert.equal(f[axis], d[axis]);
  }
  assert.notEqual(c.x, d.x);
  assert.notEqual(c.z, d.z);
});

test("a real family fork has noncoplanar depth instead of a single bent sheet", () => {
  const people = [
    p("a", [], ["b"]),
    p("b", [], ["a"]),
    p("c", ["a", "b"]),
    p("d", ["a", "b"]),
  ];
  const geometry: TreeGeometry = {
    mode: "generations",
    reverse: false,
    start: 0,
    offset: 0,
    positions: [
      ["a", { x: -140, y: 0 }],
      ["b", { x: 140, y: 0 }],
      ["c", { x: -200, y: 400 }],
      ["d", { x: 200, y: 400 }],
    ],
  };
  const world = spatialWorld(new Map(people.map((p) => [p.id, p])), geometry);
  const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => world.points.get(id)!);
  const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z },
    v = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z },
    w = { x: d.x - a.x, y: d.y - a.y, z: d.z - a.z };
  const volume =
    u.x * (v.y * w.z - v.z * w.y) -
    u.y * (v.x * w.z - v.z * w.x) +
    u.z * (v.x * w.y - v.y * w.x);
  assert.ok(
    Math.abs(volume) > 1_000_000,
    "four people must not all lie in a plane",
  );
  assert.ok(
    c.z * d.z < 0,
    "two descendant branches extend in opposite depth directions",
  );
  assert.equal(Math.hypot(b.x - a.x, b.z - a.z), 280);
  assert.equal(a.y, b.y);
  assert.equal(c.y, d.y);
  assert.deepEqual(
    spatialWorld(new Map([...people].reverse().map((p) => [p.id, p])), {
      ...geometry,
      positions: [...geometry.positions].reverse(),
    }).points,
    world.points,
  );
});

test("unmarried co-parents stay close without creating a partner edge", () => {
  const people = [p("a"), p("b"), p("c", ["a", "b"])];
  const world = spatialWorld(new Map(people.map((p) => [p.id, p])), {
    mode: "generations",
    reverse: false,
    start: 0,
    offset: 0,
    positions: [
      ["a", { x: 0, y: 0 }],
      ["b", { x: 280, y: 0 }],
      ["c", { x: 100, y: 400 }],
    ],
  });
  assert.equal(world.connections.filter((e) => e.type === "partner").length, 0);
  assert.equal(world.connections.filter((e) => e.type === "parent").length, 2);
  const a = world.points.get("a")!,
    b = world.points.get("b")!;
  assert.equal(Math.hypot(a.x - b.x, a.z - b.z), 280);
});

test("dense and cyclic imported coordinates terminate without duplicate or inaccessible points", () => {
  const people = Array.from({ length: 1000 }, (_, i) =>
    p(String(i), i ? [String(i - 1)] : ["999"]),
  );
  const world = spatialWorld(new Map(people.map((p) => [p.id, p])), {
    mode: "generations",
    reverse: false,
    start: 0,
    offset: 0,
    positions: people.map((p) => [p.id, { x: 0, y: 0 }]),
  });
  assert.equal(world.points.size, 1000);
  assert.equal(
    new Set([...world.points.values()].map((p) => `${p.x}:${p.z}`)).size,
    1000,
  );
  assert.ok(
    [...world.points.values()].every((p) =>
      Object.values(p).every(Number.isFinite),
    ),
  );
});

test("3D includes only authorised geometry, coalesces occurrences and terminates on bad imported cycles", () => {
  const geometry = fixtureGeometry(family.people);
  geometry.positions.push(["me-copy", { x: 5000, y: 2000 }]);
  geometry.occurrences = [{ id: "me-copy", personId: "me" }] as NonNullable<
    TreeGeometry["occurrences"]
  >;
  const world = spatialWorld(
    new Map(family.people.filter((p) => p.id !== "dad").map((p) => [p.id, p])),
    geometry,
  );
  assert.equal(world.points.size, family.people.length - 1);
  assert.ok(!world.points.has("dad"));
  assert.ok(!world.points.has("me-copy"));
  assert.ok(
    world.connections.every(
      (e) => world.points.has(e.from) && world.points.has(e.to),
    ),
  );
  assert.deepEqual(
    spatialWorld(new Map(), { ...geometry, positions: [] }).points.size,
    0,
  );
});

test("3D keeps a positive shared size floor without a label count or zoom gate", () => {
  assert.equal(spatialCardLimit(390), 150);
  assert.equal(spatialCardLimit(1440), 190);
  for (const width of [390, 1440]) {
    let previous = Infinity;
    for (const count of [0, 16, 100, 200, 1000, 20_000]) {
      const floor = spatialCardFloor(width, count);
      assert.ok(floor > 0 && floor <= spatialCardLimit(width));
      assert.ok(floor <= previous);
      previous = floor;
    }
  }
  assert.equal(spatialCardFloor(1440, 100), 112);
  assert.equal(spatialCardFloor(390, 100), 96);
  assert.ok(
    spatialCardFloor(390, 16, 40_000) < spatialCardFloor(390, 16, 200_000),
  );
  assert.ok(spatialCardFloor(1440, 200, 300_000) < 50);
});
