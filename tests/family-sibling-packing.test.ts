import test from "node:test";
import assert from "node:assert/strict";
import { shortenFamilyRows } from "../src/domain/family-row-shortening.ts";
import { packedSiblingRows } from "../src/domain/family-sibling-packing.ts";
import { familyAxisQuality } from "../src/domain/family-axis.ts";
import {
  createGeometryContactScorer,
  type UnionBranch,
} from "../src/domain/union-layout.ts";
import type { TreeGeometry, LayoutPerson } from "../src/domain/tree-layout.ts";

const size = { width: 220, height: 264 };
function fixture(reverse: boolean, mirror: boolean) {
  const positions: TreeGeometry["positions"] = [
    ["ancestor", { x: 400, y: 0 }],
    ["s0", { x: 0, y: 500 }],
    ["s1", { x: 284, y: 500 }],
    ["s2", { x: 568, y: 500 }],
    ["other-parent", { x: 1625, y: 500 }],
    ["s3", { x: 1909, y: 500 }],
    ["s4", { x: 2193, y: 500 }],
    ["distant-parent", { x: 2477, y: 500 }],
    ["child-a", { x: 1400, y: 1000 }],
    ["child-b", { x: 1652, y: 1000 }],
    ["unrelated", { x: 4000, y: 500 }],
  ];
  const points = new Map(positions);
  const edges = [
    ...["s0", "s1", "s2", "s3", "s4"].map((id) => ["ancestor", id]),
    ["other-parent", "child-a"],
    ["distant-parent", "child-b"],
  ];
  const branches: UnionBranch[] = edges.map(([source, target]) => {
    const a = points.get(source)!,
      b = points.get(target)!;
    const start = { x: a.x + 110, y: a.y + 264 },
      end = { x: b.x + 110, y: b.y };
    return {
      id: `child:${target}`,
      source,
      target,
      union: source,
      relations: [{ type: "parent", from: source, to: target }],
      route: {
        sourceHandle: "bottom",
        targetHandle: "top",
        points: [
          start,
          { x: start.x, y: end.y - 60 },
          { x: end.x, y: end.y - 60 },
          end,
        ],
      },
    };
  });
  branches.push({
    id: "pair:children",
    source: "child-a",
    target: "child-b",
    union: "children",
    relations: [{ type: "spouse", from: "child-a", to: "child-b" }],
    route: {
      sourceHandle: "right",
      targetHandle: "left",
      points: [
        { x: 1620, y: 1132 },
        { x: 1652, y: 1132 },
      ],
    },
  });
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
      block: id.startsWith("child-") ? "children" : id,
    })),
    blocks: [
      {
        id: "children",
        members: ["child-a", "child-b"],
        x: 1400,
        y: 1000,
        width: 472,
        height: 264,
      },
    ],
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
      p.y = 1000 - p.y;
    });
    geometry.blocks!.forEach((b) => {
      b.y = 1000 - b.y;
    });
    geometry.generationBands!.forEach((b) => {
      b.targetY = b.minY = b.maxY = 1000 - b.targetY;
    });
    branches.forEach((b) => {
      if (b.id.startsWith("child:")) {
        b.route.sourceHandle = "top";
        b.route.targetHandle = "bottom";
      }
      b.route.points.forEach((p) => {
        p.y = 1264 - p.y;
      });
    });
  }
  if (mirror) {
    geometry.positions.forEach(([, p]) => {
      p.x = 4220 - p.x - 220;
    });
    geometry.blocks!.forEach((b) => {
      b.x = 4220 - b.x - b.width;
    });
    branches.forEach((b) => {
      if (b.id.startsWith("pair:")) {
        b.route.sourceHandle = "left";
        b.route.targetHandle = "right";
      }
      b.route.points.forEach((p) => {
        p.x = 4220 - p.x;
      });
    });
  }
  const people: LayoutPerson[] = positions.map(([id]) => ({
    id,
    birth: "",
    parents: edges.filter(([, to]) => to === id).map(([from]) => from),
    spouses:
      id === "child-a" ? ["child-b"] : id === "child-b" ? ["child-a"] : [],
  }));
  return { geometry, people };
}

test("regroups siblings across an unrelated ancestor and reclaims the gap for both parents of a marriage", () => {
  for (const reverse of [false, true])
    for (const mirror of [false, true]) {
      const { geometry, people } = fixture(reverse, mirror),
        original = structuredClone(geometry);
      const scorer = createGeometryContactScorer(size.width, size.height);
      const score = (g: TreeGeometry) => ({
        ...scorer.quality(g),
        cardHits: scorer.cardContacts(g),
        overlaps: scorer.cardOverlaps(g),
      });
      const result = shortenFamilyRows(geometry, people, [], size, score);
      assert.notStrictEqual(result, geometry);
      assert.equal(familyAxisQuality(geometry, size).interleavings, 1);
      assert.equal(familyAxisQuality(result, size).interleavings, 0);
      assert.ok(score(result).length < score(geometry).length - 500);
      for (const key of [
        "crossings",
        "contacts",
        "cardHits",
        "overlaps",
        "bends",
      ] as const)
        assert.ok(score(result)[key] <= score(geometry)[key], key);
      const old = new Map(geometry.positions),
        current = new Map(result.positions);
      assert.ok(
        Math.abs(current.get("distant-parent")!.x - current.get("child-b")!.x) <
          Math.abs(old.get("distant-parent")!.x - old.get("child-b")!.x),
      );
      for (const id of ["ancestor", "child-a", "child-b", "unrelated"])
        assert.deepEqual(current.get(id), old.get(id));
      for (const [id, p] of result.positions) assert.equal(p.y, old.get(id)!.y);
      assert.deepEqual(
        result.branches!.map((b) => [b.id, b.relations]),
        geometry.branches!.map((b) => [b.id, b.relations]),
      );
      assert.deepEqual(geometry, original);
    }
});

test("packing is bounded and never proposed for the chronology view or oversized scenes", () => {
  const { geometry } = fixture(false, false);
  assert.ok([...packedSiblingRows(geometry, size)].length <= 128);
  assert.equal(
    [...packedSiblingRows({ ...geometry, mode: "timeline" }, size)].length,
    0,
  );
  assert.equal(
    [
      ...packedSiblingRows(
        {
          ...geometry,
          positions: Array.from({ length: 601 }, () => geometry.positions[0]),
        },
        size,
      ),
    ].length,
    0,
  );
});
