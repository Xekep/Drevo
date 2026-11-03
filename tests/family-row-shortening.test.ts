import test from "node:test";
import assert from "node:assert/strict";
import { shortenFamilyRows } from "../src/domain/family-row-shortening.ts";
import {
  createGeometryContactScorer,
  type UnionBranch,
} from "../src/domain/union-layout.ts";
import { familyAxisQuality } from "../src/domain/family-axis.ts";
import type { LayoutPerson, TreeGeometry } from "../src/domain/tree-layout.ts";

const size = { width: 220, height: 264 };
function fixture(reverse: boolean) {
  const positions: TreeGeometry["positions"] = [
    ["grandparent-a", { x: 694, y: 0 }],
    ["grandparent-b", { x: 946, y: 0 }],
    ["parent-a", { x: 0, y: 500 }],
    ["parent-b", { x: 252, y: 500 }],
    ...Array.from({ length: 5 }, (_, i): TreeGeometry["positions"][number] => [
      `sibling-${i}`,
      { x: 536 + i * 284, y: 500 },
    ]),
    ["child", { x: 1546, y: 1000 }],
    ["unrelated", { x: 3000, y: 500 }],
  ];
  const points = new Map(positions);
  const owner = (id: string) =>
    id.startsWith("grandparent")
      ? "grandparents"
      : id.startsWith("parent")
        ? "parents"
        : id;
  const branches: UnionBranch[] = [
    "parent-b",
    ...Array.from({ length: 5 }, (_, i) => `sibling-${i}`),
    "child",
  ].map((target) => {
    const parent = target === "child" ? "parent-a" : "grandparent-a";
    const start = {
      x: target === "child" ? 236 : 930,
      y: target === "child" ? 632 : 132,
    };
    const end = { x: points.get(target)!.x + 110, y: points.get(target)!.y };
    const y = end.y - 70;
    return {
      id: `child:${target}`,
      source: parent,
      target,
      union: owner(parent),
      relations: [
        parent,
        target === "child" ? "parent-b" : "grandparent-b",
      ].map((from) => ({ type: "parent" as const, from, to: target })),
      route: {
        sourceHandle: "bottom",
        targetHandle: "top",
        points: [start, { x: start.x, y }, { x: end.x, y }, end],
      },
    };
  });
  for (const [source, target] of [
    ["parent-a", "parent-b"],
    ["grandparent-a", "grandparent-b"],
  ]) {
    const a = points.get(source)!,
      b = points.get(target)!;
    branches.push({
      id: `pair:${owner(source)}`,
      source,
      target,
      union: owner(source),
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
    blocks: ["grandparents", "parents"].map((id) => {
      const members = positions.filter(([p]) => owner(p) === id);
      return {
        id,
        members: members.map(([p]) => p),
        ...members[0][1],
        width: 472,
        height: 264,
      };
    }),
    generationBands: [0, 500, 1000].map((y, level) => ({
      level,
      targetY: y,
      minY: y,
      maxY: y,
      members: positions.filter(([, p]) => p.y === y).map(([id]) => id),
    })),
  };
  if (reverse) {
    geometry.positions.forEach(([, p]) => {
      p.y = 1264 - p.y - 264;
    });
    geometry.blocks!.forEach((b) => {
      b.y = 1264 - b.y - 264;
    });
    geometry.branches!.forEach((b) => {
      if (b.route.sourceHandle === "bottom") {
        b.route.sourceHandle = "top";
        b.route.targetHandle = "bottom";
      }
      b.route.points.forEach((p) => {
        p.y = 1264 - p.y;
      });
    });
    geometry.generationBands!.forEach((b) => {
      b.targetY = b.minY = b.maxY = 1000 - b.targetY;
    });
  }
  const people: LayoutPerson[] = positions.map(([id]) => ({
    id,
    birth: "",
    parents: [],
    spouses: [],
  }));
  return { geometry, people };
}

test("a parent household trades sibling slots to straighten its only child's route without requiring crossings", () => {
  for (const reverse of [false, true]) {
    const { geometry, people } = fixture(reverse),
      snapshot = structuredClone(geometry);
    const scorer = createGeometryContactScorer(size.width, size.height);
    const score = (g: TreeGeometry) => ({
      ...scorer.quality(g),
      cardHits: scorer.cardContacts(g),
      overlaps: scorer.cardOverlaps(g),
    });
    assert.equal(score(geometry).crossings, 0);
    const result = shortenFamilyRows(geometry, people, [], size, score);
    const positions = new Map(result.positions),
      prior = new Map(geometry.positions);
    assert.equal(positions.get("parent-a")!.x, 1420);
    assert.equal(positions.get("parent-b")!.x, 1672);
    assert.deepEqual(positions.get("child"), prior.get("child"));
    assert.deepEqual(positions.get("unrelated"), prior.get("unrelated"));
    assert.equal(positions.get("sibling-0")!.x, 0);
    assert.deepEqual(
      result.positions.map(([id, p]) => [id, p.y]),
      geometry.positions.map(([id, p]) => [id, p.y]),
    );
    const route = result.branches!.find((b) => b.target === "child")!.route
      .points;
    assert.ok(
      route.every((p) => p.x === 1656),
      "the long horizontal detour becomes one vertical line",
    );
    assert.ok(score(result).length < score(geometry).length);
    assert.equal(score(result).crossings, 0);
    assert.equal(score(result).contacts, 0);
    assert.equal(score(result).cardHits, 0);
    assert.equal(score(result).overlaps, 0);
    assert.ok(
      familyAxisQuality(result, size).offset <=
        familyAxisQuality(geometry, size).offset,
    );
    assert.deepEqual(
      result.branches!.map((b) => [b.id, b.relations]),
      geometry.branches!.map((b) => [b.id, b.relations]),
    );
    assert.deepEqual(geometry, snapshot);
    assert.strictEqual(
      shortenFamilyRows(result, people, [], size, score),
      result,
    );
  }
});
