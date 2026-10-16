import test from "node:test";
import assert from "node:assert/strict";
import type { Family, Person } from "../src/domain/types.ts";
import { treeDepthBranches } from "../src/domain/tree-depth.ts";
import { depthWorld, projectDepth, DEPTH_PREVIEW_LIMIT } from "../src/domain/tree-depth-scene.ts";
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
  assert.ok(sibling.connections.some((edge) => edge.from === "dad" && edge.to === "sibling" && edge.type === "parent"));
  assert.ok(sibling.connections.some((edge) => edge.from === "mom" && edge.to === "sibling"));
  assert.deepEqual(view.back.find((branch) => branch.anchorId === "isolate")!.connections, []);
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
    assert.ok(allowed.has(edge.from)); assert.ok(allowed.has(edge.to));
  }
});

const geometry: TreeGeometry = { mode: "generations", reverse: false, start: 0, offset: 0,
  nodeSize: { width: 220, height: 264 },
  positions: [["dad", { x: 0, y: 0 }], ["me", { x: 0, y: 400 }]] };

test("spatial branches retain real attachments, have depth and rotate without moving front geometry", () => {
  const people = new Map(family.people.map((person) => [person.id, person]));
  const before = structuredClone({ family, geometry });
  const view = treeDepthBranches(family, all, "me");
  const world = depthWorld(view.back, people, geometry, "me");
  const scene = world.scenes.find((item) => item.branch.anchorId === "sibling")!;
  const sibling = scene.points.get("sibling")!, nephew = scene.points.get("nephew")!;
  assert.ok(sibling.z < 0); assert.ok(nephew.y > sibling.y);
  assert.ok(nephew.z < sibling.z);
  const a = projectDepth(sibling, world.pivot, -24), b = projectDepth(sibling, world.pivot, 24);
  assert.notEqual(a.x, b.x); assert.notEqual(a.z, b.z);
  assert.ok(a.scale > 0 && a.scale < 1.2);
  assert.deepEqual(world.front.get("me"), { x: 110, y: 532, z: 0 });
  assert.deepEqual({ family, geometry }, before);
  const reverse = depthWorld(view.back, people, { ...geometry, reverse: true }, "me")
    .scenes.find((item) => item.branch.anchorId === "sibling")!;
  assert.ok(reverse.points.get("nephew")!.y < reverse.points.get("sibling")!.y);
});

test("preview follows actual civil unions and bounds a large branch without inventing links", () => {
  const graph: Family = { ...family, people: [p("root"), p("me", ["root"]), p("sibling", ["root"]),
    p("partner"), ...Array.from({ length: 60 }, (_, i) => p(`child-${i}`, [i ? `child-${i - 1}` : "partner"]))],
    unions: [{ id: "civil", participants: ["sibling", "partner"], type: "civil_union" }], links: [] };
  const view = treeDepthBranches(graph, new Set(graph.people.map((p) => p.id)), "me");
  const world = depthWorld(view.back, new Map(graph.people.map((p) => [p.id, p])), geometry, "me");
  assert.equal(world.scenes.length, 1);
  const scene = world.scenes[0];
  assert.equal(scene.points.size, DEPTH_PREVIEW_LIMIT);
  assert.ok(scene.points.has("sibling") && scene.points.has("partner") && scene.points.has("child-0"));
  assert.equal(scene.connections.filter((edge) => edge.type === "partner").length, 1);
  assert.ok(!scene.connections.some((edge) => edge.from === "me" || edge.to === "me"));
});

test("resting projection separates unrelated branches and keeps a wide sibling row readable", () => {
  const graph: Family = { ...family, links: [], unions: [], people: [p("dad"), p("me", ["dad"]),
    p("sibling", ["dad"]), ...Array.from({ length: 22 }, (_, i) => p(`nephew-${i}`, ["sibling"])),
    ...Array.from({ length: 12 }, (_, i) => p(`isolate-${i}`))] };
  const view = treeDepthBranches(graph, new Set(graph.people.map((p) => p.id)), "me");
  const world = depthWorld(view.back, new Map(graph.people.map((p) => [p.id, p])), geometry, "me");
  const rectangles = world.scenes.flatMap((scene) => [...scene.points].map(([id, point]) => {
    const projected = projectDepth(point, world.pivot, 0);
    return { id, x: projected.x, y: projected.y };
  }));
  for (let i = 0; i < rectangles.length; i++) for (let j = i + 1; j < rectangles.length; j++) {
    const a = rectangles[i], b = rectangles[j];
    assert.ok(Math.abs(a.x - b.x) >= 290 || Math.abs(a.y - b.y) >= 270,
      `overlapping rear cards: ${a.id}, ${b.id}`);
  }
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
