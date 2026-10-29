import test from "node:test";
import assert from "node:assert/strict";
import type { LayoutPerson, TreeGeometry } from "../src/domain/tree-layout.ts";
import { optimizeFamilyRows } from "../src/domain/family-row-order.ts";
import { optimizeDisplayedTree } from "../src/domain/optimize-tree-layout.ts";
import {
  createGeometryContactScorer,
  unionGeometry,
} from "../src/domain/union-layout.ts";
import ELK from "elkjs/lib/elk.bundled.js";
import { randomFamily } from "./layout-fixtures.ts";
import { familyBlockConflicts } from "../src/domain/local-family-order.ts";
import { routeRelationships } from "../src/domain/edge-routing.ts";

const size = { width: 220, height: 264 };
function fixture(children: number[], parents = [0, 600, 1200]): TreeGeometry {
  const positions: TreeGeometry["positions"] = [
    ...parents.map(
      (x, i) => [`p${i}`, { x, y: 0 }] as [string, { x: number; y: number }],
    ),
    ...children.map(
      (x, i) => [`c${i}`, { x, y: 500 }] as [string, { x: number; y: number }],
    ),
  ];
  return {
    mode: "generations",
    reverse: false,
    start: 1700,
    offset: 0,
    nodeSize: size,
    positions,
    occurrences: positions.map(([id]) => ({ id, personId: id, block: id })),
    generationBands: [
      {
        level: 0,
        targetY: 0,
        minY: -30,
        maxY: 30,
        members: parents.map((_, i) => `p${i}`),
      },
      {
        level: 1,
        targetY: 500,
        minY: 470,
        maxY: 530,
        members: children.map((_, i) => `c${i}`),
      },
    ],
    routes: [],
    branches: children.map((x, i) => ({
      id: `child:c${i}`,
      source: `p${i}`,
      target: `c${i}`,
      union: `origin${i}`,
      relations: [{ from: `p${i}`, to: `c${i}`, type: "parent" }],
      route: {
        sourceHandle: "bottom",
        targetHandle: "top",
        points: [
          { x: parents[i] + 110, y: 264 },
          { x: parents[i] + 110, y: 340 + i * 12 },
          { x: x + 110, y: 340 + i * 12 },
          { x: x + 110, y: 500 },
        ],
      },
    })),
  };
}
function mirrored(g: TreeGeometry): TreeGeometry {
  return {
    ...g,
    reverse: true,
    positions: g.positions.map(([id, p]) => [id, { x: p.x, y: -p.y }]),
    generationBands: g.generationBands!.map((b) => ({
      ...b,
      targetY: -b.targetY,
      minY: -b.maxY,
      maxY: -b.minY,
    })),
    branches: g.branches!.map((b) => ({
      ...b,
      route: {
        ...b.route,
        sourceHandle:
          b.route.sourceHandle === "bottom"
            ? "top"
            : b.route.sourceHandle === "top"
              ? "bottom"
              : b.route.sourceHandle,
        targetHandle:
          b.route.targetHandle === "top"
            ? "bottom"
            : b.route.targetHandle === "bottom"
              ? "top"
              : b.route.targetHandle,
        points: b.route.points.map((p) => ({ x: p.x, y: size.height - p.y })),
      },
    })),
  };
}
function people(g: TreeGeometry): LayoutPerson[] {
  return g.positions.map(([id]) => ({
    id,
    birth: "",
    parents: [],
    spouses: [],
  }));
}
function score() {
  const scorer = createGeometryContactScorer(size.width, size.height);
  return (g: TreeGeometry) => ({
    ...scorer.quality(g),
    cardHits: scorer.cardContacts(g),
    overlaps: scorer.cardOverlaps(g),
  });
}
function unchangedStructure(before: TreeGeometry, after: TreeGeometry) {
  assert.deepEqual(after.occurrences, before.occurrences);
  assert.deepEqual(after.generationBands, before.generationBands);
  assert.deepEqual(
    after.positions.map(([id, p]) => [id, p.y]),
    before.positions.map(([id, p]) => [id, p.y]),
  );
  assert.deepEqual(
    after.branches!.map((b) => [b.id, b.relations]),
    before.branches!.map((b) => [b.id, b.relations]),
  );
  assert.deepEqual(after.nodeSize, size);
  const positions = new Map(after.positions);
  for (const b of after.branches!) {
    const offset = (handle: string) =>
      handle === "right" ? size.width : handle === "left" ? 0 : size.width / 2;
    assert.equal(
      b.route.points[0].x,
      positions.get(b.source)!.x + offset(b.route.sourceHandle),
    );
    assert.equal(
      b.route.points.at(-1)!.x,
      positions.get(b.target)!.x + offset(b.route.targetHandle),
    );
    for (let i = 1; i < b.route.points.length; i++)
      assert.ok(
        b.route.points[i - 1].x === b.route.points[i].x ||
          b.route.points[i - 1].y === b.route.points[i].y,
      );
  }
}
for (const reverse of [false, true]) {
  test(`partners move as one household when a gap closes (reverse=${reverse})`, () => {
    const original = fixture([0, 3000], [0, 1000]);
    original.positions.push(["partner", { x: 3252, y: 500 }]);
    original.occurrences!.push({
      id: "partner",
      personId: "partner",
      block: "c1",
    });
    original.generationBands![1].members.push("partner");
    original.blocks = [
      {
        id: "c1",
        members: ["c1", "partner"],
        x: 3000,
        y: 500,
        width: 472,
        height: 264,
      },
    ];
    original.branches!.push({
      id: "pair:c1",
      source: "c1",
      target: "partner",
      union: "couple-c1",
      relations: [{ from: "c1", to: "partner", type: "spouse" }],
      route: {
        sourceHandle: "right",
        targetHandle: "left",
        points: [
          { x: 3220, y: 632 },
          { x: 3252, y: 632 },
        ],
      },
    });
    const before = reverse ? mirrored(original) : original,
      saved = structuredClone(before);
    const after = optimizeFamilyRows(before, people(before), [], size, score());
    const positions = new Map(after.positions);
    assert.ok(positions.get("c1")!.x < 3000);
    assert.equal(positions.get("partner")!.x - positions.get("c1")!.x, 252);
    assert.equal(after.blocks![0].x, positions.get("c1")!.x);
    assert.equal(score()(after).cardHits, 0);
    assert.equal(score()(after).overlaps, 0);
    unchangedStructure(before, after);
    assert.deepEqual(before, saved);
  });
  test(`secondary links retain their endpoints after a row reorders (reverse=${reverse})`, () => {
    const original = fixture([1200, 0, 600]);
    const before = reverse ? mirrored(original) : original;
    const links = [{ type: "godparent" as const, from: "p2", to: "c0" }];
    before.routes = routeRelationships(
      people(before),
      links,
      before.positions,
      size.width,
      size.height,
      new Set(),
      before.branches!.map((branch) => ({
        group: branch.union,
        route: branch.route,
      })),
    );
    const metrics = score(),
      after = optimizeFamilyRows(before, people(before), links, size, metrics);
    assert.ok(metrics(after).crossings < metrics(before).crossings);
    assert.equal(after.routes!.length, 1);
    assert.equal(after.routes![0][0], before.routes[0][0]);
    assert.equal(metrics(after).cardHits, 0);
    assert.equal(metrics(after).overlaps, 0);
    unchangedStructure(before, after);
  });
  test(`generation row sifting reduces crossings without changing Y (reverse=${reverse})`, () => {
    const before = reverse
      ? mirrored(fixture([1200, 0, 600]))
      : fixture([1200, 0, 600]);
    const saved = structuredClone(before),
      metrics = score();
    const after = optimizeFamilyRows(before, people(before), [], size, metrics);
    assert.ok(metrics(after).crossings < metrics(before).crossings);
    assert.equal(metrics(after).cardHits, 0);
    assert.equal(metrics(after).overlaps, 0);
    unchangedStructure(before, after);
    assert.deepEqual(before, saved);
    assert.deepEqual(
      optimizeFamilyRows(before, people(before), [], size, score()),
      after,
    );
  });
  test(`explicit print optimization improves the displayed permutation, not family data (reverse=${reverse})`, () => {
    const before = reverse ? mirrored(fixture([1200, 0, 600])) : fixture([1200, 0, 600]);
    const saved = structuredClone(before), peopleBefore = people(before);
    const input = structuredClone(peopleBefore);
    const { geometry: after, optimization } = optimizeDisplayedTree(before, input, []);
    assert.equal(optimization.changed, true);
    assert.ok(optimization.after.crossings < optimization.before.crossings);
    unchangedStructure(before, after);
    assert.deepEqual(before, saved);
    assert.deepEqual(input, peopleBefore);
    assert.throws(() => optimizeDisplayedTree({ ...before, mode: "timeline" }, input, []), /2D/);
  });
  test(`a needless gap closes toward family anchors without making cards smaller (reverse=${reverse})`, () => {
    const before = reverse
      ? mirrored(fixture([0, 3000], [0, 1000]))
      : fixture([0, 3000], [0, 1000]);
    const metrics = score(),
      after = optimizeFamilyRows(before, people(before), [], size, metrics);
    const a = new Map(before.positions),
      b = new Map(after.positions);
    assert.ok(
      b.get("c1")!.x - b.get("c0")!.x < a.get("c1")!.x - a.get("c0")!.x,
    );
    assert.ok(metrics(after).length < metrics(before).length);
    assert.equal(metrics(after).crossings, 0);
    assert.equal(metrics(after).cardHits, 0);
    assert.equal(metrics(after).overlaps, 0);
    unchangedStructure(before, after);
  });
}
test("cold portrait placement does not select a solver solely to reduce the total width", async () => {
  const engine = new ELK({ algorithms: ["layered"] }),
    family = randomFamily(4, 4);
  let calls = 0;
  const result = await unionGeometry(
    family,
    (graph) => {
      calls++;
      assert.notEqual(
        graph.layoutOptions?.["elk.layered.nodePlacement.strategy"],
        "NETWORK_SIMPLEX",
      );
      return engine.layout(graph);
    },
    false,
    [],
    size,
  );
  assert.ok(calls <= 7);
  assert.equal(
    new Set(result.occurrences!.map((p) => p.personId)).size,
    family.length,
  );
  assert.equal(score()(result).cardHits, 0);
  assert.equal(score()(result).overlaps, 0);
});

test("medium cold graphs keep the original probes and bound independent alternatives", async () => {
  const engine = new ELK({ algorithms: ["layered"] });
  const family = randomFamily(1, 4);
  for (let i = 0; i < 10; i++) family.push({ id: `isolated-${i}`, birth: "", parents: [], spouses: [] });
  assert.ok(family.length > 200 && family.length <= 300);
  let calls = 0, originals = 0, independent = 0;
  const geometry = await unionGeometry(family, (graph) => {
    calls++;
    if (graph.layoutOptions?.["elk.layered.nodePlacement.strategy"] === "NETWORK_SIMPLEX") {
      if (graph.layoutOptions["elk.layered.considerModelOrder.strategy"] === "NONE") independent++;
      else originals++;
    }
    return engine.layout(graph);
  }, false, [], size);
  assert.ok(calls <= 11);
  assert.equal(originals, 2, "new strategies cannot remove the productive original probes");
  assert.ok(independent >= 1 && independent <= 2);
  assert.equal(geometry.positions.length, family.length);
  assert.equal(score()(geometry).cardHits, 0);
  assert.equal(score()(geometry).overlaps, 0);
});

/** Twenty-five early households have 576 distinct insertions but only T contacts. */
function lateCrossingFixture(large: boolean): TreeGeometry {
  const early = fixture(
    Array.from({ length: 25 }, (_, i) => (i + 1) * 300),
    Array.from({ length: 25 }, (_, i) => i * 300),
  );
  for (const branch of early.branches!) {
    branch.route.points[1].y = 340;
    branch.route.points[2].y = 340;
  }
  const late = fixture([1200, 0, 600]);
  const rename = (id: string) => `late-${id}`;
  early.positions.push(...late.positions.map(([id, p]) =>
    [rename(id), { ...p, y: p.y + 2000 }] as [string, { x: number; y: number }],
  ));
  early.occurrences!.push(...late.occurrences!.map((o) => ({
    id: rename(o.id), personId: rename(o.personId), block: rename(o.block),
  })));
  early.generationBands!.push(...late.generationBands!.map((band) => ({
    ...band, level: band.level + 2, targetY: band.targetY + 2000,
    minY: band.minY + 2000, maxY: band.maxY + 2000,
    members: band.members.map(rename),
  })));
  early.branches!.push(...late.branches!.map((branch) => ({
    ...branch, id: rename(branch.id), source: rename(branch.source),
    target: rename(branch.target), union: rename(branch.union),
    relations: branch.relations.map((r) => ({ ...r, from: rename(r.from), to: rename(r.to) })),
    route: { ...branch.route, points: branch.route.points.map((p) => ({ ...p, y: p.y + 2000 })) },
  })));
  // Routing recognizes child branches by this prefix.
  for (const branch of early.branches!)
    if (branch.id.startsWith("late-")) branch.id = `child:${branch.id}`;
  if (large) {
    const isolated = Array.from({ length: 301 - early.positions.length }, (_, i) => `isolated-${i}`);
    early.positions.push(...isolated.map((id, i) =>
      [id, { x: i * 300, y: 4000 }] as [string, { x: number; y: number }],
    ));
    early.occurrences!.push(...isolated.map((id) => ({ id, personId: id, block: id })));
    early.generationBands!.push({
      level: 4, targetY: 4000, minY: 3970, maxY: 4030, members: isolated,
    });
  }
  return early;
}

for (const reverse of [false, true]) for (const large of [false, true]) {
  test(`T-only early rows cannot starve a later crossing (reverse=${reverse}, large=${large})`, () => {
    const original = lateCrossingFixture(large),
      before = reverse ? mirrored(original) : original,
      saved = structuredClone(before), metrics = score(),
      conflicts = familyBlockConflicts(before);
    assert.equal(conflicts.crossed.has("p0"), false);
    assert.ok(Array.from({ length: 25 }, (_, i) => `p${i}`).every((id) => conflicts.contacts.has(id)));
    assert.ok([...conflicts.crossed].some((id) => id.startsWith("late-")));
    assert.ok(metrics(before).crossings > 0);
    assert.equal(metrics(before).cardHits, 0);
    assert.equal(metrics(before).overlaps, 0);
    let firstMoved: string[] | undefined;
    const old = new Map(before.positions);
    const after = optimizeFamilyRows(before, people(before), [], size, (geometry) => {
      const moved = geometry.positions.filter(([id, p]) => old.get(id)!.x !== p.x).map(([id]) => id);
      if (moved.length && !firstMoved) firstMoved = moved;
      return metrics(geometry);
    });
    assert.equal(metrics(after).crossings, 0);
    assert.ok(firstMoved?.length);
    assert.ok(firstMoved.every((id) => id.startsWith("late-")));
    assert.ok(metrics(after).contacts <= metrics(before).contacts);
    assert.equal(metrics(after).cardHits, 0);
    assert.equal(metrics(after).overlaps, 0);
    unchangedStructure(before, after);
    assert.deepEqual(before, saved);
    assert.deepEqual(optimizeFamilyRows(before, people(before), [], size, score()), after);
  });
}
