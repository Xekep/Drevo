import test from "node:test";
import assert from "node:assert/strict";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import type { UnionBranch } from "../src/domain/union-layout.ts";
import { createGeometryContactScorer } from "../src/domain/union-layout.ts";
import { mirroredFamilyBranches } from "../src/domain/family-branch-mirror.ts";
import { familyBranchMoves } from "../src/domain/family-branch-moves.ts";
import { optimizeFinalFamilyBranches } from "../src/domain/final-family-branches.ts";
import { preferFamilyLayout } from "../src/domain/family-layout-candidates.ts";
import { routeRelationships } from "../src/domain/edge-routing.ts";

const size = { width: 220, height: 264 };
function fixture(reverse: boolean): TreeGeometry {
  const positions: TreeGeometry["positions"] = [
    ["ancestor", { x: 1400, y: 0 }],
    ["parent", { x: 1200, y: 500 }],
    ["partner", { x: 1452, y: 500 }],
    ["other", { x: 600, y: 500 }],
    ["shared-a", { x: 500, y: 1000 }],
    ["shared-b", { x: 752, y: 1000 }],
    ["sibling", { x: 1500, y: 1000 }],
    ["leaf", { x: 1500, y: 1500 }],
    ["shared-leaf", { x: 500, y: 1500 }],
  ];
  const points = new Map(positions);
  const children: [string, string, number][] = [
    ["ancestor", "parent", 350],
    ["parent", "shared-a", 850],
    ["other", "shared-b", 880],
    ["parent", "sibling", 850],
    ["sibling", "leaf", 1350],
    ["shared-a", "shared-leaf", 1350],
  ];
  const branches: UnionBranch[] = children.map(([source, target, lane]) => ({
    id: `child:${source}:${target}`,
    source,
    target,
    union: source,
    relations: [{ type: "parent", from: source, to: target }],
    route: {
      sourceHandle: "bottom",
      targetHandle: "top",
      points: [
        { x: points.get(source)!.x + 110, y: points.get(source)!.y + 264 },
        { x: points.get(source)!.x + 110, y: lane },
        { x: points.get(target)!.x + 110, y: lane },
        { x: points.get(target)!.x + 110, y: points.get(target)!.y },
      ],
    },
  }));
  const owner = (id: string) =>
    id === "partner" ? "parent" : id === "shared-b" ? "shared-a" : id;
  for (const [source, target] of [
    ["parent", "partner"],
    ["shared-a", "shared-b"],
  ]) {
    const a = points.get(source)!,
      b = points.get(target)!;
    branches.push({
      id: `pair:${source}`,
      source,
      target,
      union: source,
      relations: [{ type: "spouse", from: source, to: target }],
      route: {
        sourceHandle: "right",
        targetHandle: "left",
        points: [
          { x: a.x + 220, y: a.y + 132 },
          { x: b.x, y: b.y + 132 },
        ],
      },
    });
  }
  const geometry: TreeGeometry = {
    mode: "generations",
    reverse,
    start: 1700,
    offset: 0,
    nodeSize: size,
    positions,
    branches,
    routes: [],
    occurrences: positions.map(([id]) => ({
      id,
      personId: id,
      block: owner(id),
    })),
    blocks: ["parent", "shared-a"].map((id) => ({
      id,
      members: positions.filter(([p]) => owner(p) === id).map(([p]) => p),
      ...points.get(id)!,
      width: 472,
      height: 264,
    })),
    generationBands: [0, 500, 1000, 1500].map((y, level) => ({
      level,
      targetY: y,
      minY: y,
      maxY: y,
      members: positions.filter(([, p]) => p.y === y).map(([id]) => id),
    })),
  };
  if (!reverse) return geometry;
  const handle = (h: "top" | "bottom" | "left" | "right") =>
    h === "top" ? "bottom" : h === "bottom" ? "top" : h;
  return {
    ...geometry,
    positions: positions.map(([id, p]) => [id, { ...p, y: -p.y }]),
    blocks: geometry.blocks!.map((b) => ({ ...b, y: -b.y })),
    generationBands: geometry.generationBands!.map((b) => ({
      ...b,
      targetY: -b.targetY,
      minY: -b.maxY,
      maxY: -b.minY,
    })),
    branches: branches.map((b) => ({
      ...b,
      route: {
        ...b.route,
        sourceHandle: handle(b.route.sourceHandle),
        targetHandle: handle(b.route.targetHandle),
        points: b.route.points.map((p) => ({ ...p, y: 264 - p.y })),
      },
    })),
  };
}
function scorer() {
  const s = createGeometryContactScorer(220, 264);
  return (g: TreeGeometry) => ({
    ...s.quality(g),
    cardHits: s.cardContacts(g),
    overlaps: s.cardOverlaps(g),
  });
}
for (const reverse of [false, true]) {
  test(`branch reflection preserves the connecting household and every genealogical fact (reverse=${reverse})`, () => {
    const original = fixture(reverse),
      saved = structuredClone(original);
    const move = mirroredFamilyBranches(original, size).find((m) =>
      m.moved.has("ancestor"),
    );
    assert.ok(move);
    assert.deepEqual(
      move.moved,
      new Set(["ancestor", "parent", "partner", "sibling", "leaf"]),
    );
    const old = new Map(original.positions);
    for (const [id, p] of move.geometry.positions)
      assert.deepEqual(p, {
        ...old.get(id)!,
        x: move.moved.has(id) ? 1472 - old.get(id)!.x - 220 : old.get(id)!.x,
      });
    const marriage = move.geometry.branches!.find(
      (b) => b.id === "pair:parent",
    )!;
    assert.equal(marriage.route.sourceHandle, "left");
    assert.equal(marriage.route.targetHandle, "right");
    assert.deepEqual(
      move.geometry.branches!.map((b) => b.relations),
      original.branches!.map((b) => b.relations),
    );
    assert.deepEqual(move.geometry.generationBands, original.generationBands);
    assert.deepEqual(move.geometry.occurrences, original.occurrences);
    assert.deepEqual(original, saved);
    const people = original.positions.map(([id]) => ({
        id,
        birth: "",
        parents: [],
        spouses: [],
      })),
      score = scorer();
    const after = optimizeFinalFamilyBranches(
      original,
      people,
      [],
      size,
      score,
    );
    assert.ok(
      preferFamilyLayout(after, original, size, score),
      JSON.stringify({ before: score(original), after: score(after) }),
    );
    assert.ok(score(after).crossings < score(original).crossings);
    assert.equal(score(after).cardHits, 0);
    assert.equal(score(after).overlaps, 0);
  });
}
test("a descendant translation stops at a household belonging to both ancestral sides", () => {
  const original = fixture(false),
    saved = structuredClone(original);
  const moves = familyBranchMoves(original, size, [
    { blocks: ["parent"], preferredShift: -1000, stopAtSharedChildren: true },
  ]);
  assert.ok(moves.length);
  for (const move of moves) {
    assert.deepEqual(
      move.moved,
      new Set(["parent", "partner", "sibling", "leaf"]),
    );
    assert.ok(move.preserved.has("child:sibling:leaf"));
    assert.ok(!move.preserved.has("child:parent:shared-a"));
    assert.deepEqual(
      new Map(move.geometry.positions).get("shared-a"),
      new Map(original.positions).get("shared-a"),
    );
  }
  assert.deepEqual(original, saved);
});
test("a shared ancestor prevents reflection of an inseparable pair of ancestral sides", () => {
  const g = fixture(false),
    branch = structuredClone(g.branches![0]);
  branch.id = "child:ancestor:other";
  branch.target = "other";
  g.branches!.push(branch);
  assert.equal(mirroredFamilyBranches(g, size).length, 0);
});
test("final branch moves reroute extra relationships against the accepted positions", () => {
  const g = fixture(false),
    people = g.positions.map(([id]) => ({
      id,
      birth: "",
      parents: [],
      spouses: [],
    }));
  const links = [{ type: "godparent" as const, from: "ancestor", to: "other" }];
  g.routes = routeRelationships(
    people,
    links,
    g.positions,
    220,
    264,
    new Set(),
    g.branches!.map((b) => ({ group: b.union, route: b.route })),
  );
  const after = optimizeFinalFamilyBranches(g, people, links, size, scorer());
  assert.notEqual(after, g, "the fixture must exercise accepted movement with an extra relationship");
  assert.equal(after.routes!.length, 1);
  assert.deepEqual(
    after.routes,
    routeRelationships(
      people,
      links,
      after.positions,
      220,
      264,
      new Set(),
      after.branches!.map((b) => ({ group: b.union, route: b.route })),
    ),
  );
});
