import test from "node:test";
import assert from "node:assert/strict";
import type { LayoutPerson, TreeGeometry } from "../src/domain/tree-layout.ts";
import { centerFamilyBranches } from "../src/domain/family-centering.ts";
import {
  createGeometryContactScorer,
  unionGeometry,
} from "../src/domain/union-layout.ts";
import ELK from "elkjs/lib/elk.bundled.js";
import { randomFamily } from "./layout-fixtures.ts";

const size = { width: 220, height: 264 };
function family(reverse = false): TreeGeometry {
  const y = (value: number) => (reverse ? 1000 - value : value);
  const positions: TreeGeometry["positions"] = [
    ["parent", { x: 0, y: y(0) }],
    ["older", { x: 700, y: y(500) }],
    ["partner", { x: 952, y: y(500) }],
    ["younger", { x: 1350, y: y(500) }],
    ["grandchild", { x: 826, y: y(1000) }],
  ];
  const branch = (
    source: string,
    target: string,
    union: string,
    startX?: number,
  ) => {
    const from = positions.find(([id]) => id === source)![1];
    const to = positions.find(([id]) => id === target)![1];
    const first = {
      x: startX ?? from.x + 110,
      y: from.y + (reverse ? 0 : 264),
    };
    const last = { x: to.x + 110, y: to.y + (reverse ? 264 : 0) };
    const middle = (first.y + last.y) / 2;
    return {
      id: `child:${target}`,
      source,
      target,
      union,
      relations: [{ type: "parent" as const, from: source, to: target }],
      route: {
        sourceHandle: reverse ? ("top" as const) : ("bottom" as const),
        targetHandle: reverse ? ("bottom" as const) : ("top" as const),
        points: [
          first,
          { x: first.x, y: middle },
          { x: last.x, y: middle },
          last,
        ],
      },
    };
  };
  return {
    mode: "generations",
    reverse,
    start: 1700,
    offset: 0,
    nodeSize: size,
    positions,
    occurrences: positions.map(([id]) => ({
      id,
      personId: id,
      block: id === "partner" ? "older" : id,
    })),
    blocks: [
      {
        id: "older",
        members: ["older", "partner"],
        x: 700,
        y: y(500),
        width: 472,
        height: 264,
      },
    ],
    generationBands: [0, 500, 1000].map((value, level) => ({
      level,
      targetY: y(value),
      minY: y(value) - 30,
      maxY: y(value) + 30,
      members: positions
        .filter(([, point]) => point.y === y(value))
        .map(([id]) => id),
    })),
    routes: [],
    branches: [
      branch("parent", "older", "siblings"),
      branch("parent", "younger", "siblings"),
      branch("older", "grandchild", "descendants", 936),
      {
        id: "pair:older",
        source: "older",
        target: "partner",
        union: "descendants",
        relations: [{ type: "spouse", from: "older", to: "partner" }],
        route: {
          sourceHandle: "right",
          targetHandle: "left",
          points: [
            { x: 920, y: y(500) + 132 },
            { x: 952, y: y(500) + 132 },
          ],
        },
      },
    ],
  };
}
function people(geometry: TreeGeometry): LayoutPerson[] {
  return geometry.positions.map(([id]) => ({
    id,
    birth: "",
    parents: [],
    spouses: [],
  }));
}
function scorer() {
  const value = createGeometryContactScorer(size.width, size.height);
  return (geometry: TreeGeometry) => ({
    ...value.quality(geometry),
    cardHits: value.cardContacts(geometry),
    overlaps: value.cardOverlaps(geometry),
  });
}

for (const reverse of [false, true]) {
  test(`a sibling forest uses separate free intervals around an unrelated family (reverse=${reverse})`, () => {
    const before = family(reverse);
    const xs = new Map([
      ["parent", 1000],
      ["older", 600],
      ["younger", 1800],
    ]);
    before.positions = before.positions
      .filter(([id]) => xs.has(id))
      .map(([id, point]) => [id, { ...point, x: xs.get(id)! }]);
    const childY = before.positions.find(([id]) => id === "older")![1].y;
    before.positions.push(["fixed", { x: 1100, y: childY }]);
    before.occurrences = before.positions.map(([id]) => ({
      id,
      personId: id,
      block: id,
    }));
    before.blocks = [];
    before.generationBands = before
      .generationBands!.slice(0, 2)
      .map((band, i) => ({
        ...band,
        members: i ? ["older", "fixed", "younger"] : ["parent"],
      }));
    before.branches = before
      .branches!.slice(0, 2)
      .map((branch) => ({
        ...branch,
        route: {
          ...branch.route,
          points: branch.route.points.map((point, i) => ({
            ...point,
            x: i < 2 ? 1110 : xs.get(branch.target)! + 110,
          })),
        },
      }));
    const score = scorer(),
      after = centerFamilyBranches(before, people(before), [], size, score);
    const points = new Map(after.positions);
    assert.equal(points.get("parent")!.x, 1000);
    assert.equal(points.get("older")!.x, 400);
    assert.equal(points.get("younger")!.x, 1600);
    assert.equal(points.get("fixed")!.x, 1100);
    assert.equal(
      score(after).length,
      score(before).length,
      "equal wire length still permits better family centering",
    );
    assert.equal(score(after).crossings, 0);
    assert.equal(score(after).cardHits, 0);
    assert.equal(score(after).overlaps, 0);
  });
  test(`a free sibling forest centers under parents without changing its internal layout (reverse=${reverse})`, () => {
    const before = family(reverse),
      saved = structuredClone(before),
      score = scorer();
    const after = centerFamilyBranches(before, people(before), [], size, score);
    const points = new Map(after.positions),
      old = new Map(before.positions);
    assert.equal(points.get("parent")!.x, old.get("parent")!.x);
    assert.equal((points.get("older")!.x + points.get("younger")!.x) / 2, 0);
    const dx = points.get("older")!.x - old.get("older")!.x;
    for (const id of ["partner", "younger", "grandchild"])
      assert.equal(points.get(id)!.x - old.get(id)!.x, dx);
    assert.deepEqual(
      after.branches!.find((b) => b.id === "child:grandchild")!.route.points,
      before
        .branches!.find((b) => b.id === "child:grandchild")!
        .route.points.map((point) => ({ ...point, x: point.x + dx })),
    );
    assert.equal(points.get("partner")!.x - points.get("older")!.x, 252);
    assert.deepEqual(after.generationBands, before.generationBands);
    assert.deepEqual(after.occurrences, before.occurrences);
    assert.deepEqual(
      after.positions.map(([id, point]) => [id, point.y]),
      before.positions.map(([id, point]) => [id, point.y]),
    );
    assert.equal(score(after).overlaps, 0);
    assert.equal(score(after).cardHits, 0);
    assert.equal(score(after).crossings, 0);
    assert.ok(score(after).length < score(before).length);
    assert.deepEqual(before, saved);
    assert.deepEqual(
      centerFamilyBranches(before, people(before), [], size, score),
      after,
    );
    assert.deepEqual(
      centerFamilyBranches(after, people(after), [], size, score),
      after,
    );
  });
  test(`a free space in the child row cannot hide an occupied lower generation (reverse=${reverse})`, () => {
    const before = family(reverse);
    const y = before.positions.find(([id]) => id === "grandchild")![1].y;
    before.positions.push(["fixed", { x: -199, y }]);
    before.occurrences!.push({
      id: "fixed",
      personId: "fixed",
      block: "fixed",
    });
    before.generationBands![2].members.push("fixed");
    const score = scorer(),
      after = centerFamilyBranches(before, people(before), [], size, score);
    assert.deepEqual(
      after.positions.find(([id]) => id === "fixed"),
      before.positions.find(([id]) => id === "fixed"),
    );
    assert.equal(score(after).overlaps, 0);
    assert.equal(score(after).cardHits, 0);
    assert.ok(score(after).crossings <= score(before).crossings);
    const points = new Map(after.positions);
    const gap =
      Math.abs(points.get("grandchild")!.x - points.get("fixed")!.x) - 220;
    assert.ok(
      points.get("parent")!.x > 0,
      "the unconstrained ancestry can move instead of dragging descendants into an occupied row",
    );
    assert.equal(points.get("older")!.x, 700);
    assert.ok(
      gap >= 88 - 0.01,
      "centering preserves breathing room between unrelated families",
    );
  });
  test(`cold centering validates the final bundled routes (reverse=${reverse})`, async () => {
    const elk = new ELK();
    const geometry = await unionGeometry(
      randomFamily(2, 3),
      (input) => elk.layout(input),
      reverse,
      [],
      size,
    );
    const quality = scorer()(geometry);
    // This synthetic graph had 42 crossings / 44 contacts before centering.
    // Accepting moves before the final bus bundling introduced 43 / 45.
    assert.ok(quality.crossings <= 42);
    assert.ok(quality.contacts <= 44);
    assert.equal(quality.cardHits, 0);
    assert.equal(quality.overlaps, 0);
  });
}

test("centering leaves a timeline and an oversized scene untouched", () => {
  const before = family(),
    score = scorer();
  const timeline = { ...before, mode: "timeline" as const };
  assert.equal(
    centerFamilyBranches(timeline, people(timeline), [], size, score),
    timeline,
  );
  const large = {
    ...before,
    positions: Array.from(
      { length: 1201 },
      (_, i) =>
        [`p${i}`, { x: i * 300, y: 0 }] as TreeGeometry["positions"][number],
    ),
  };
  assert.equal(
    centerFamilyBranches(large, people(large), [], size, score),
    large,
  );
});
