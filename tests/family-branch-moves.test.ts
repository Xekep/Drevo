import test from "node:test";
import assert from "node:assert/strict";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { familyBranchMoves, FAMILY_BRANCH_LIMITS } from "../src/domain/family-branch-moves.ts";
import { familyRowNoWorse, reorderFamilyRow, routeFamilyMove, translateFamilyBlocks } from "../src/domain/family-row-moves.ts";
import { optimizeFamilyRows } from "../src/domain/family-row-order.ts";
import { placedFamilyRows } from "../src/domain/local-family-order.ts";
import { createGeometryContactScorer, type UnionBranch } from "../src/domain/union-layout.ts";

const size = { width: 220, height: 264 };
function child(source: string, target: string, positions: TreeGeometry["positions"], lane: number): UnionBranch {
  const points = new Map(positions), first = points.get(source)!, last = points.get(target)!;
  return {
    id: `child:${source}:${target}`, source, target, union: `family:${source}`,
    relations: [{ from: source, to: target, type: "parent" }],
    route: { sourceHandle: "bottom", targetHandle: "top", points: [
      { x: first.x + 110, y: first.y + 264 }, { x: first.x + 110, y: lane },
      { x: last.x + 110, y: lane }, { x: last.x + 110, y: last.y },
    ] },
  };
}
function geometry(positions: TreeGeometry["positions"], branches: UnionBranch[]): TreeGeometry {
  const ys = [...new Set(positions.map(([, p]) => p.y))].sort((a, b) => a - b);
  return {
    mode: "generations", reverse: false, start: 1700, offset: 0, nodeSize: size,
    positions, routes: [], branches,
    occurrences: positions.map(([id]) => ({ id, personId: id, block: id })),
    generationBands: ys.map((y, level) => ({
      level, targetY: y, minY: y - 30, maxY: y + 30,
      members: positions.filter(([, p]) => p.y === y).map(([id]) => id),
    })),
  };
}
function fixture(): TreeGeometry {
  const positions: TreeGeometry["positions"] = [
    ["P", { x: 0, y: 0 }], ["Q", { x: 600, y: 0 }],
    ["A", { x: 1200, y: 500 }], ["B", { x: 600, y: 500 }],
    ["a", { x: 1200, y: 1000 }], ["b", { x: 600, y: 1000 }],
  ];
  return geometry(positions, [
    child("P", "A", positions, 350), child("Q", "B", positions, 370),
    child("A", "a", positions, 850), child("B", "b", positions, 870),
  ]);
}
function mirror(original: TreeGeometry): TreeGeometry {
  return {
    ...original, reverse: true,
    positions: original.positions.map(([id, p]) => [id, { x: p.x, y: -p.y }]),
    generationBands: original.generationBands!.map((b) => ({
      ...b, targetY: -b.targetY, minY: -b.maxY, maxY: -b.minY,
    })),
    branches: original.branches!.map((b) => ({
      ...b, route: { ...b.route,
        sourceHandle: b.route.sourceHandle === "bottom" ? "top" : b.route.sourceHandle,
        targetHandle: b.route.targetHandle === "top" ? "bottom" : b.route.targetHandle,
        points: b.route.points.map((p) => ({ x: p.x, y: size.height - p.y })),
      },
    })),
  };
}
function scorer() {
  const s = createGeometryContactScorer(size.width, size.height);
  return (g: TreeGeometry) => ({ ...s.quality(g), cardHits: s.cardContacts(g), overlaps: s.cardOverlaps(g) });
}
function translated(before: TreeGeometry, after: TreeGeometry, moved: Set<string>, dx: number) {
  const old = new Map(before.positions);
  for (const [id, p] of after.positions)
    assert.deepEqual(p, { ...old.get(id)!, x: old.get(id)!.x + (moved.has(id) ? dx : 0) });
  assert.deepEqual(after.occurrences, before.occurrences);
  assert.deepEqual(after.generationBands, before.generationBands);
  assert.deepEqual(after.nodeSize, before.nodeSize);
  assert.deepEqual(after.branches!.map((b) => [b.id, b.source, b.target, b.relations]),
    before.branches!.map((b) => [b.id, b.source, b.target, b.relations]));
}

for (const reverse of [false, true]) {
  test(`a rigid descendant shift removes the crossing that a root-only shift moves downstream (reverse=${reverse})`, () => {
    const original = fixture(), before = reverse ? mirror(original) : original,
      saved = structuredClone(before), score = scorer();
    const isolated = routeFamilyMove(translateFamilyBlocks(before, new Map([["A", -1200]])), size);
    const upper = (g: TreeGeometry) => score({ ...g, branches: g.branches!.slice(0, 2) }).crossings;
    const lower = (g: TreeGeometry) => score({ ...g, branches: g.branches!.slice(2) }).crossings;
    assert.equal(upper(before), 1);
    assert.equal(lower(before), 0);
    assert.equal(upper(isolated), 0);
    assert.equal(lower(isolated), 1);
    assert.equal(score(isolated).crossings, score(before).crossings);
    const candidates = familyBranchMoves(before, size, ["A"]);
    const move = candidates.find((m) => new Map(m.geometry.positions).get("A")!.x === 0)!;
    assert.ok(move);
    assert.deepEqual(move.moved, new Set(["A", "a"]));
    assert.deepEqual(move.preserved, new Set(["child:A:a"]));
    const after = routeFamilyMove(move, size, move.preserved);
    assert.equal(score(after).crossings, 0);
    assert.equal(score(after).contacts, 0);
    assert.equal(score(after).cardHits, 0);
    assert.equal(score(after).overlaps, 0);
    assert.ok(familyRowNoWorse(score(after), score(before)));
    assert.ok(score(after).length < score(before).length);
    translated(before, after, move.moved, -1200);
    assert.deepEqual(before, saved);
    assert.deepEqual(familyBranchMoves(before, size, ["A"]), candidates);
  });
}

test("all household members and their descendants move together, including a second co-parent input", () => {
  const original = fixture();
  original.positions.push(["partner", { x: 1452, y: 500 }], ["other-child", { x: 1452, y: 1000 }]);
  original.occurrences!.push({ id: "partner", personId: "partner", block: "A" },
    { id: "other-child", personId: "other-child", block: "other-child" });
  original.generationBands![1].members.push("partner");
  original.generationBands![2].members.push("other-child");
  original.branches!.push(child("partner", "other-child", original.positions, 890));
  original.blocks = [{ id: "A", members: ["A", "partner"], x: 1200, y: 500, width: 472, height: 264 }];
  original.branches!.push({ id: "pair:A", source: "A", target: "partner", union: "family:A", relations: [],
    route: { sourceHandle: "right", targetHandle: "left", points: [{ x: 1420, y: 632 }, { x: 1452, y: 632 }] } });
  original.branches!.push(child("Q", "a", original.positions, 410));
  const move = familyBranchMoves(original, size, ["A"]).find((m) => new Map(m.geometry.positions).get("A")!.x === 0)!;
  assert.ok(move);
  assert.deepEqual(move.moved, new Set(["A", "partner", "a", "other-child"]));
  assert.equal(move.preserved.has("child:Q:a"), false);
  assert.equal(move.preserved.has("child:partner:other-child"), true);
  assert.equal(move.preserved.has("pair:A"), true);
  const after = routeFamilyMove(move, size, move.preserved);
  translated(original, after, move.moved, -1200);
  assert.equal(after.blocks![0].x, 0);
  const oldInput = original.branches!.find((b) => b.id === "child:Q:a")!,
    newInput = after.branches!.find((b) => b.id === oldInput.id)!;
  assert.deepEqual(newInput.route.points[0], oldInput.route.points[0]);
  assert.equal(newInput.route.points.at(-1)!.x, new Map(after.positions).get("a")!.x + 110);
});

test("a free card contour does not exempt an internal detour from full route safety", () => {
  const original = fixture();
  original.positions.find(([id]) => id === "a")![1].y = 1500;
  original.generationBands![2].members = ["b"];
  original.generationBands!.push({ level: 3, targetY: 1500, minY: 1470, maxY: 1530, members: ["a"] });
  original.branches!.find((b) => b.id === "child:A:a")!.route.points = [
    { x: 1310, y: 764 }, { x: 1310, y: 800 }, { x: 1910, y: 800 },
    { x: 1910, y: 1400 }, { x: 1310, y: 1400 }, { x: 1310, y: 1500 },
  ];
  const score = scorer();
  assert.equal(score(original).cardHits, 0);
  const move = familyBranchMoves(original, size, ["A"]).find((m) => new Map(m.geometry.positions).get("A")!.x === 0)!;
  assert.ok(move);
  assert.equal(score(move.geometry).overlaps, 0);
  assert.ok(score(move.geometry).cardHits > 0);
  const after = routeFamilyMove(move, size, move.preserved);
  assert.ok(score(after).cardHits > 0);
  assert.equal(familyRowNoWorse(score(after), score(original)), false);
});

test("a pair split across households cannot detach its stationary endpoint", () => {
  const original = fixture();
  original.branches!.push({ id: "pair:invalid", source: "A", target: "B", union: "invalid", relations: [],
    route: { sourceHandle: "left", targetHandle: "right", points: [{ x: 1200, y: 632 }, { x: 820, y: 632 }] } });
  assert.deepEqual(familyBranchMoves(original, size, ["A"]), []);
});

function chain(count: number) {
  const positions: TreeGeometry["positions"] = [
    ["parent", { x: 0, y: -500 }],
    ...Array.from({ length: count }, (_, i) => [`n${i}`, { x: 1200, y: i * 500 }] as [string, { x: number; y: number }]),
  ];
  return geometry(positions, [child("parent", "n0", positions, -150),
    ...Array.from({ length: count - 1 }, (_, i) => child(`n${i}`, `n${i + 1}`, positions, i * 500 + 350))]);
}
test("closure size, root scans, boundary routes and candidate counts have hard bounds", () => {
  const supported = chain(FAMILY_BRANCH_LIMITS.households);
  assert.ok(familyBranchMoves(supported, size, ["n0"]).length);
  assert.deepEqual(familyBranchMoves(chain(FAMILY_BRANCH_LIMITS.households + 1), size, ["n0"]), []);
  assert.deepEqual(familyBranchMoves(supported, size,
    [...Array.from({ length: FAMILY_BRANCH_LIMITS.roots }, (_, i) => `missing${i}`), "n0"]), []);
  const moves = familyBranchMoves(fixture(), size, ["A", "B", "P", "Q"], 1);
  assert.equal(moves.length, 1);
  assert.deepEqual(familyBranchMoves(fixture(), size, ["A"], 0), []);
  const crowded = chain(2);
  for (let i = 0; i < FAMILY_BRANCH_LIMITS.boundaryRoutes; i++) {
    const id = `extra${i}`;
    crowded.positions.push([id, { x: -300 * (i + 1), y: -500 }]);
    crowded.occurrences!.push({ id, personId: id, block: id });
    crowded.generationBands![0].members.push(id);
    crowded.branches!.push(child(id, "n0", crowded.positions, -200 + i * 10));
  }
  assert.deepEqual(familyBranchMoves(crowded, size, ["n0"]), []);
});


test("an oversized household and a backward generation edge are rejected without a partial closure", () => {
  const oversized = chain(2);
  for (let i = 0; i < FAMILY_BRANCH_LIMITS.people; i++) {
    const id = `partner-${i}`;
    oversized.positions.push([id, { x: 1452 + i * 252, y: 0 }]);
    oversized.occurrences!.push({ id, personId: id, block: "n0" });
    oversized.generationBands![1].members.push(id);
  }
  assert.deepEqual(familyBranchMoves(oversized, size, ["n0"]), []);
  const cyclic = chain(2);
  cyclic.branches!.push(child("n1", "n0", cyclic.positions, 850));
  assert.deepEqual(familyBranchMoves(cyclic, size, ["n0"]), []);
});


function anchoredFixture(large: boolean) {
  const result = fixture();
  result.positions.push(["R", { x: 0, y: -500 }], ["S", { x: 600, y: -500 }]);
  result.branches!.push(child("R", "P", result.positions, -150), child("S", "Q", result.positions, -130));
  if (large) for (let i = 0; i < 293; i++)
    result.positions.push([`isolated-${i}`, { x: i * 300, y: 2000 }]);
  return geometry(result.positions, result.branches!);
}
for (const reverse of [false, true]) for (const large of [false, true]) {
  test(`the bounded cold pipeline shifts several generations after every single-row exchange fails (reverse=${reverse}, large=${large})`, () => {
    const original = anchoredFixture(large), before = reverse ? mirror(original) : original,
      saved = structuredClone(before), score = scorer();
    assert.equal(score(before).crossings, 1);
    // Every nontrivial family row has exactly two households. Each exchange
    // either retains the old crossing or creates one above/below that row.
    for (const row of placedFamilyRows(before, size).filter((row) => row.length === 2)) {
      const move = reorderFamilyRow(before, row, 0, 1)!;
      assert.ok(score(routeFamilyMove(move, size)).crossings >= score(before).crossings);
    }
    const people = before.positions.map(([id]) => ({ id, birth: "", parents: [], spouses: [] }));
    const after = optimizeFamilyRows(before, people, [], size, score);
    assert.equal(score(after).crossings, 0);
    assert.equal(score(after).contacts, 0);
    assert.equal(score(after).cardHits, 0);
    assert.equal(score(after).overlaps, 0);
    assert.ok(familyRowNoWorse(score(after), score(before)));
    const positions = new Map(after.positions), old = new Map(before.positions);
    assert.equal(positions.get("A")!.x - old.get("A")!.x, positions.get("a")!.x - old.get("a")!.x);
    assert.ok(positions.get("A")!.x < old.get("A")!.x);
    assert.deepEqual(after.generationBands, before.generationBands);
    assert.deepEqual(after.positions.map(([id, p]) => [id, p.y]), before.positions.map(([id, p]) => [id, p.y]));
    assert.deepEqual(before, saved);
    assert.deepEqual(optimizeFamilyRows(before, people, [], size, scorer()), after);
  });
}


test("earlier T-only households cannot hide a later clade from the bounded root scan", () => {
  const late = anchoredFixture(false), earlyPositions: TreeGeometry["positions"] = [];
  for (let i = 0; i < 25; i++) earlyPositions.push(
    [`early-parent-${i}`, { x: i * 300, y: -2000 }],
    [`early-child-${i}`, { x: (i + 1) * 300, y: -1500 }],
  );
  const earlyBranches = Array.from({ length: 25 }, (_, i) =>
    child(`early-parent-${i}`, `early-child-${i}`, earlyPositions, -1660),
  );
  const before = geometry([...earlyPositions, ...late.positions], [...earlyBranches, ...late.branches!]);
  const score = scorer();
  assert.equal(score(before).crossings, 1);
  assert.equal(score(before).contacts, 25);
  const people = before.positions.map(([id]) => ({ id, birth: "", parents: [], spouses: [] }));
  const after = optimizeFamilyRows(before, people, [], size, score);
  assert.equal(score(after).crossings, 0);
  assert.equal(score(after).cardHits, 0);
  assert.equal(score(after).overlaps, 0);
});

test("two distinct union joints translate with a three-person household and keep their own children", () => {
  const positions: TreeGeometry["positions"] = [
    ["P", { x: 0, y: 0 }], ["Q", { x: 1000, y: 0 }],
    ["A", { x: 1800, y: 500 }], ["shared", { x: 2052, y: 500 }],
    ["partner", { x: 2304, y: 500 }], ["B", { x: 1000, y: 500 }],
    ["a", { x: 1800, y: 1000 }], ["second", { x: 2304, y: 1000 }],
    ["b", { x: 1000, y: 1000 }],
  ];
  const firstChild = child("A", "a", positions, 850), secondChild = child("shared", "second", positions, 870);
  firstChild.union = "first-union";
  secondChild.union = "second-union";
  firstChild.route.points[0] = { x: 2036, y: 632 };
  firstChild.route.points[1].x = 2036;
  secondChild.route.points[0] = { x: 2288, y: 632 };
  secondChild.route.points[1].x = 2288;
  const pair = (source: string, target: string, union: string, x: number): UnionBranch => ({
    id: `pair:${union}`, source, target, union, relations: [{ from: source, to: target, type: "spouse" }],
    route: { sourceHandle: "right", targetHandle: "left", points: [{ x, y: 632 }, { x: x + 32, y: 632 }] },
  });
  const before = geometry(positions, [
    child("P", "A", positions, 350), child("Q", "B", positions, 370),
    pair("A", "shared", "first-union", 2020), pair("shared", "partner", "second-union", 2272),
    firstChild, secondChild, child("B", "b", positions, 890),
  ]);
  for (const o of before.occurrences!) if (["A", "shared", "partner"].includes(o.id)) o.block = "household";
  before.blocks = [{ id: "household", members: ["A", "shared", "partner"], x: 1800, y: 500, width: 724, height: 264 }];
  const move = familyBranchMoves(before, size, ["household"]).find((m) => new Map(m.geometry.positions).get("A")!.x === 0)!;
  assert.ok(move);
  assert.deepEqual(move.moved, new Set(["A", "shared", "partner", "a", "second"]));
  const after = routeFamilyMove(move, size, move.preserved), score = scorer();
  for (const id of [firstChild.id, secondChild.id, "pair:first-union", "pair:second-union"]) {
    const old = before.branches!.find((b) => b.id === id)!, next = after.branches!.find((b) => b.id === id)!;
    assert.ok(move.preserved.has(id));
    assert.deepEqual(next.route.points, old.route.points.map((p) => ({ ...p, x: p.x - 1800 })));
    assert.equal(next.union, old.union);
    assert.deepEqual(next.relations, old.relations);
  }
  translated(before, after, move.moved, -1800);
  assert.equal(score(after).crossings, 0);
  assert.equal(score(after).contacts, 0);
  assert.equal(score(after).cardHits, 0);
  assert.equal(score(after).overlaps, 0);
});

test("touching forbidden intervals retain a gap that fits the translated household exactly", () => {
  const positions: TreeGeometry["positions"] = [
    ["P", { x: 0, y: 0 }], ["A", { x: 1200, y: 500 }], ["a", { x: 1200, y: 1000 }],
    ["left", { x: -284, y: 500 }], ["right", { x: 284, y: 500 }],
  ];
  const before = geometry(positions, [child("P", "A", positions, 350), child("A", "a", positions, 850)]);
  const move = familyBranchMoves(before, size, ["A"]).find((m) => new Map(m.geometry.positions).get("A")!.x === 0)!;
  assert.ok(move);
  const score = scorer(), after = routeFamilyMove(move, size, move.preserved);
  assert.equal(score(after).cardHits, 0);
  assert.equal(score(after).overlaps, 0);
});

test("the cold descendant search does not replace retained positions after an edit", () => {
  const before = anchoredFixture(false), score = scorer();
  const people = before.positions.map(([id]) => ({ id, birth: "", parents: [], spouses: [] }));
  const after = optimizeFamilyRows(before, people, [], size, score, before);
  assert.strictEqual(after, before);
  assert.equal(score(after).crossings, 1);
});
