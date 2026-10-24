import test from "node:test";
import assert from "node:assert/strict";
import { bundleFamilyBranches } from "../src/domain/family-branch-bundling.ts";
import { segmentContact, segmentHitsBox } from "../src/domain/edge-routing.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import type { UnionBranch } from "../src/domain/union-layout.ts";
import { routingContactScore } from "../src/domain/routing-quality.ts";

function fixture(): TreeGeometry {
  const branches: UnionBranch[] = [-190, 410].map((x, i) => ({
    id: `child:${i}`, source: "parent", target: `child${i}`, union: "parents",
    relations: [{ from: "parent", to: `child${i}`, type: "parent" }],
    route: { sourceHandle: "bottom", targetHandle: "top", points: [
      { x: 110, y: 84 }, { x: 110, y: 140 + i * 40 },
      { x, y: 140 + i * 40 }, { x, y: 400 },
    ] },
  }));
  return { mode: "generations", reverse: false, start: 1700, offset: 0,
    nodeSize: { width: 220, height: 84 }, branches,
    positions: [["parent", { x: 0, y: 0 }], ["child0", { x: -300, y: 400 }], ["child1", { x: 300, y: 400 }]],
    generationBands: [{ level: 1, targetY: 400, minY: 370, maxY: 430, members: ["child0", "child1"] }],
  };
}
const horizontal = (branch: UnionBranch) => branch.route.points.slice(1)
  .filter((p, i) => p.y === branch.route.points[i].y && p.x !== branch.route.points[i].x).map((p) => p.y);

test("siblings share a single corridor without moving cards or changing relationships", () => {
  const original = fixture(), snapshot = structuredClone(original);
  const result = bundleFamilyBranches(original);
  assert.deepEqual(result.positions, original.positions);
  assert.deepEqual(result.generationBands, original.generationBands);
  assert.deepEqual(result.branches!.map(horizontal), [[242], [242]]);
  result.branches!.forEach((branch, i) => {
    assert.deepEqual(branch.relations, original.branches![i].relations);
    assert.deepEqual(branch.route.points[0], original.branches![i].route.points[0]);
    assert.deepEqual(branch.route.points.at(-1), original.branches![i].route.points.at(-1));
  });
  assert.deepEqual(original, snapshot);
  assert.deepEqual(bundleFamilyBranches(result), result);
});

test("a shared corridor avoids cards and cannot create a new contact with another family", () => {
  for (const obstacle of ["card", "line"]) {
    const input = fixture();
    if (obstacle === "card") input.positions.push(["obstacle", { x: -80, y: 200 }]);
    else input.branches!.push({ id: "pair:foreign", source: "a", target: "b", union: "other",
      relations: [], route: { sourceHandle: "bottom", targetHandle: "top",
        points: [{ x: 110, y: 205 }, { x: 110, y: 280 }] } });
    const result = bundleFamilyBranches(input);
    assert.deepEqual(result.branches!.slice(0, 2).map(horizontal), [[180], [180]]);
    for (const branch of result.branches!.slice(0, 2))
      for (let i = 1; i < branch.route.points.length; i++) {
        for (const [, p] of input.positions)
          assert.equal(segmentHitsBox(branch.route.points[i - 1], branch.route.points[i],
            { left: p.x, right: p.x + 220, top: p.y, bottom: p.y + 84 }), false);
        if (obstacle === "line") assert.equal(segmentContact(branch.route.points[i - 1], branch.route.points[i],
          { x: 110, y: 205 }, { x: 110, y: 280 }), "");
      }
  }
});

test("different unions, junctions and generations never merge even when routes are nearby", () => {
  for (const difference of ["union", "junction", "generation"]) {
    const input = fixture();
    if (difference === "union") input.branches![1].union = "second-partner";
    if (difference === "junction") input.branches![1].route.points[0].x += 1;
    if (difference === "generation") {
      input.generationBands![0].members.pop();
      input.generationBands!.push({ level: 2, targetY: 400, minY: 370, maxY: 430, members: ["child1"] });
    }
    assert.equal(bundleFamilyBranches(input), input);
  }
});

test("one shared foreign-family crossing cannot split into two crossings", () => {
  const input = fixture();
  input.positions[1][1].x = 300;
  input.positions[2][1].x = 600;
  input.branches!.forEach((branch, i) => {
    const x = 410 + i * 300;
    branch.route.points = [{ x: 110, y: 84 }, { x: 110, y: 280 }, { x, y: 280 }, { x, y: 400 }];
  });
  input.branches!.push({ id: "pair:foreign", union: "foreign", source: "x", target: "y", relations: [],
    route: { sourceHandle: "right", targetHandle: "left", points: [{ x: 0, y: 260 }, { x: 1000, y: 260 }] } });
  const result = bundleFamilyBranches(input);
  assert.deepEqual(result.branches!.slice(0, 2).map(horizontal), [[280], [280]],
    "the middle corridor would split a shared trunk contact into two child-leg contacts");
});

test("shared sibling corridors mirror exactly with ancestors below", () => {
  const input = fixture(), reversed = structuredClone(input);
  reversed.reverse = true;
  reversed.positions.forEach(([, p]) => { p.y = 600 - p.y - 84; });
  reversed.branches!.forEach((b) => {
    b.route.sourceHandle = "top";
    b.route.targetHandle = "bottom";
    b.route.points.forEach((p) => { p.y = 600 - p.y; });
  });
  const forward = bundleFamilyBranches(input), backward = bundleFamilyBranches(reversed);
  assert.deepEqual(backward.branches!.map((b) => b.route.points),
    forward.branches!.map((b) => b.route.points.map((p) => ({ x: p.x, y: 600 - p.y }))));
});

test("reusing route arrays in another layout observes newly added foreign obstacles", () => {
  const input = fixture(), snapshot = structuredClone(input);
  assert.deepEqual(bundleFamilyBranches(input).branches!.map(horizontal), [[242], [242]]);
  const blocked: TreeGeometry = { ...input, branches: [...input.branches!, {
    id: "pair:foreign", union: "foreign", source: "a", target: "b", relations: [],
    route: { sourceHandle: "bottom", targetHandle: "top", points: [{ x: 110, y: 205 }, { x: 110, y: 280 }] },
  }] };
  assert.strictEqual(blocked.branches![0].route.points, input.branches![0].route.points);
  assert.deepEqual(bundleFamilyBranches(blocked).branches!.slice(0, 2).map(horizontal), [[180], [180]]);
  assert.deepEqual(bundleFamilyBranches(input).branches!.map(horizontal), [[242], [242]]);
  assert.deepEqual(input, snapshot);
});

test("a later junction of the same family observes corridors moved by an intervening family", () => {
  const groups: [string, number, number, [number, number][]][] = [
    ["A", -160, 1, [[-80, 520], [-480, 560]]],
    ["B", 480, 1, [[-80, 560], [160, 600]]],
    ["A", -480, 2, [[-640, 320], [-80, 320]]],
  ];
  const branches: UnionBranch[] = groups.flatMap(([union, x, , children], group) =>
    children.map(([endX, corridor], child) => ({
      id: `child:${group}-${child}`, union, source: `parent-${group}`, target: `${group}-${child}`, relations: [],
      route: { sourceHandle: "bottom", targetHandle: "top", points: [
        { x, y: 240 }, { x, y: corridor }, { x: endX, y: corridor }, { x: endX, y: 640 },
      ] },
    })));
  const input: TreeGeometry = { mode: "generations", reverse: false, start: 1700, offset: 0,
    nodeSize: { width: 220, height: 84 }, positions: [], branches,
    generationBands: [1, 2].map(level => ({ level, targetY: 640, minY: 610, maxY: 670,
      members: groups.flatMap(([, , rank, children], group) => rank === level ? children.map((_, child) => `${group}-${child}`) : []) })),
  };
  for (const reverse of [false, true]) {
    const geometry = structuredClone(input);
    geometry.reverse = reverse;
    if (reverse) geometry.branches!.forEach(b => {
      b.route.sourceHandle = "top"; b.route.targetHandle = "bottom";
      b.route.points.forEach(p => { p.y = 800 - p.y; });
    });
    const snapshot = structuredClone(geometry), result = bundleFamilyBranches(geometry);
    assert.deepEqual(result.branches!.map(horizontal), Array.from({ length: 6 }, () => [reverse ? 360 : 440]),
      "the last A junction must not retain contacts with B's original corridor");
    assert.deepEqual(geometry, snapshot);
  }
});

test("successive family groups preserve full contact counts with repeated unions and generations", () => {
  let seed = 527, changed = 0, touched = 0;
  const random = (limit: number) => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % limit);
  const score = (geometry: TreeGeometry) => routingContactScore(geometry.branches!.map(b => ({ id: b.id, group: b.union, route: b.route })));
  for (let trial = 0; trial < 40; trial++) {
    const branches: UnionBranch[] = [], bands = new Map<number, string[]>();
    for (let group = 0; group < 8; group++) {
      const union = `union-${group % 3}`, x = random(17) * 80 - 640, y = random(4) * 240;
      const level = group < 4 ? 1 : 2;
      for (let child = 0; child < 3; child++) {
        const id = `child:${group}-${child}`, end = { x: random(21) * 80 - 800, y: y + 400 };
        const corridor = y + 40 + random(9) * 40;
        branches.push({ id, union, source: `parent-${group}`, target: id, relations: [],
          route: { sourceHandle: "bottom", targetHandle: "top", points: [
            { x, y }, { x, y: corridor }, { x: end.x, y: corridor }, end,
          ] } });
        bands.set(level, [...bands.get(level) || [], id]);
      }
    }
    const input: TreeGeometry = { mode: "generations", reverse: false, start: 1700, offset: 0,
      nodeSize: { width: 220, height: 84 }, positions: [], branches,
      generationBands: [...bands].map(([level, members]) => ({ level, members, targetY: level * 400,
        minY: level * 400 - 30, maxY: level * 400 + 30 })) };
    const snapshot = structuredClone(input), before = score(input), result = bundleFamilyBranches(input), after = score(result);
    changed += Number(result !== input);
    touched += Number(before.quality.contacts > 0);
    assert.ok(after.quality.contacts <= before.quality.contacts);
    assert.ok(after.quality.crossings <= before.quality.crossings);
    assert.ok(after.quality.length <= before.quality.length);
    assert.deepEqual(result.branches!.map(b => [b.id, b.source, b.target, b.relations]),
      input.branches!.map(b => [b.id, b.source, b.target, b.relations]));
    assert.deepEqual(input, snapshot);
  }
  assert.ok(changed > 10, "the portfolio must exercise accepted corridor changes");
  assert.ok(touched > 10, "the portfolio must contain foreign contacts");
});
