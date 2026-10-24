import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  crowdedFamily,
  spaceSize as size,
} from "./local-family-space-fixture.ts";
import { localTreeLayout } from "../src/domain/local-tree-layout.ts";
import { localFamilySpace } from "../src/domain/local-family-space.ts";
import {
  createGeometryContactScorer,
  unionGeometry,
  type UnionBranch,
} from "../src/domain/union-layout.ts";
import { person, randomFamily } from "./layout-fixtures.ts";

test(
  "a connected 977-person ELK scene can open a crowded partner slot with only two existing moves",
  { timeout: 40000 },
  async () => {
    const people = randomFamily(5, 9),
      input = { people, links: [] },
      elk = new ELK();
    const geometry = await unionGeometry(
      people,
      (g) => elk.layout(g),
      false,
      [],
      size,
    );
    const parentIds = new Set(people.flatMap((p) => p.parents));
    const leaves = people.filter(
      (p) => !p.spouses.length && !parentIds.has(p.id),
    );
    const anchor = leaves[Math.floor((leaves.length - 1) / 2)];
    const next = {
      people: [
        ...people.map((p) =>
          p.id === anchor.id ? { ...p, spouses: ["new-partner"] } : p,
        ),
        person("new-partner", [], [anchor.id]),
      ],
      links: [],
    };
    const snapshot = structuredClone(geometry);
    const result = localTreeLayout(next, input, geometry, size);
    assert.equal(result?.kind, "local");
    assert.equal(moved(geometry, result!.geometry).length, 2);
    const points = new Map(result!.geometry.positions);
    for (const [id, p] of geometry.positions)
      assert.equal(points.get(id)!.y, p.y);
    const scorer = createGeometryContactScorer(size.width, size.height);
    const before = scorer.quality(geometry),
      after = scorer.quality(result!.geometry);
    assert.ok(after.crossings <= before.crossings);
    assert.ok(after.contacts <= before.contacts);
    assert.ok(
      scorer.cardContacts(result!.geometry) <= scorer.cardContacts(geometry),
    );
    assert.ok(
      scorer.cardOverlaps(result!.geometry) <= scorer.cardOverlaps(geometry),
    );
    assert.deepEqual(geometry, snapshot);
  },
);

const moved = (
  before: ReturnType<typeof crowdedFamily>["geometry"],
  after: typeof before,
) => {
  const points = new Map(after.positions);
  return before.positions
    .filter(([id, p]) => p.x !== points.get(id)!.x)
    .map(([id]) => id);
};

for (const reverse of [false, true])
  test(`a crowded first partner shifts only the cheapest local chain (reverse=${reverse})`, () => {
    const { input, next, geometry } = crowdedFamily(205, 2, reverse);
    const snapshot = structuredClone({ input, next, geometry });
    const result = localTreeLayout(next, input, geometry, size);
    assert.equal(result?.kind, "local");
    const after = result!.geometry;
    assert.deepEqual(moved(geometry, after), ["left-1", "left-2"]);
    const points = new Map(after.positions);
    assert.equal(points.get("anchor")!.x, 0);
    assert.equal(points.get("partner")!.x, -252);
    for (const [id, p] of geometry.positions)
      assert.equal(points.get(id)!.y, p.y);
    assert.equal(after.branches![0], geometry.branches![0]);
    assert.deepEqual(after.generationBands![0].members, [
      ...geometry.generationBands![0].members,
      "partner",
    ]);
    const score = createGeometryContactScorer(size.width, size.height);
    assert.equal(score.cardOverlaps(after), 0);
    assert.equal(score.cardContacts(after), 0);
    assert.equal(score.quality(after).crossings, 0);
    assert.deepEqual(localTreeLayout(next, input, geometry, size), result);
    assert.deepEqual({ input, next, geometry }, snapshot);
  });

for (const reverse of [false, true])
  test(`crowded partner and children are published together (reverse=${reverse})`, () => {
    const { input, next, geometry } = crowdedFamily(205, 2, reverse);
    next.people.push(
      person("child-1", ["anchor", "partner"]),
      person("child-2", ["anchor", "partner"]),
    );
    const result = localTreeLayout(next, input, geometry, size);
    assert.equal(result?.kind, "local");
    assert.deepEqual(moved(geometry, result!.geometry), ["left-1", "left-2"]);
    assert.deepEqual(
      new Set(result!.geometry.occurrences!.map((o) => o.personId)),
      new Set(next.people.map((p) => p.id)),
    );
    for (const id of ["child-1", "child-2"]) {
      const branch: UnionBranch = result!.geometry.branches!.find(
        (b) => b.target === id,
      )!;
      assert.deepEqual(
        new Set(branch.relations.map((r) => r.from)),
        new Set(["anchor", "partner"]),
      );
    }
    const score = createGeometryContactScorer(size.width, size.height);
    assert.equal(score.cardContacts(result!.geometry), 0);
    assert.equal(score.cardOverlaps(result!.geometry), 0);
    assert.equal(score.quality(result!.geometry).crossings, 0);
  });

test("a neighboring couple moves as one household and its pair route stays attached", () => {
  const { geometry } = crowdedFamily();
  const plans = [
    ...localFamilySpace(geometry, "anchor", size, new Set(["left-1"])),
  ];
  assert.equal(plans.length, 1);
  const after = plans[0],
    points = new Map(after.positions);
  assert.deepEqual(moved(geometry, after), [
    "right-1",
    "right-2",
    "neighbor-partner",
  ]);
  assert.equal(
    points.get("neighbor-partner")!.x - points.get("right-1")!.x,
    252,
  );
  const delta = points.get("right-1")!.x - 308;
  assert.equal(after.blocks![0].x, 308 + delta);
  assert.deepEqual(
    after.branches![0].route.points,
    geometry.branches![0].route.points.map((p) => ({ ...p, x: p.x + delta })),
  );
});

test("moving a household reconnects its child while other generations stay fixed", () => {
  const { geometry } = crowdedFamily();
  geometry.positions.push(["child", { x: 5000, y: 444 }]);
  geometry.occurrences!.push({
    id: "child",
    personId: "child",
    block: 'person:"child"',
  });
  geometry.generationBands!.push({
    level: 1,
    targetY: 444,
    minY: 414,
    maxY: 474,
    members: ["child"],
  });
  const union = geometry.branches![0].union;
  geometry.branches!.push({
    id: `child:${union}:child`,
    union,
    source: "right-1",
    target: "child",
    relations: ["right-1", "neighbor-partner"].map((from) => ({
      type: "parent" as const,
      from,
      to: "child",
    })),
    route: {
      sourceHandle: "bottom",
      targetHandle: "top",
      points: [
        { x: 544, y: 264 },
        { x: 544, y: 354 },
        { x: 5110, y: 354 },
        { x: 5110, y: 444 },
      ],
    },
  });
  const before = structuredClone(geometry);
  const plans = [
    ...localFamilySpace(geometry, "anchor", size, new Set(["left-1"])),
  ];
  assert.equal(plans.length, 1);
  const after = plans[0];
  assert.deepEqual(new Map(after.positions).get("child"), { x: 5000, y: 444 });
  assert.deepEqual(after.branches![1].route.points[0], { x: 796, y: 264 });
  assert.deepEqual(after.branches![1].route.points.at(-1), { x: 5110, y: 444 });
  const score = createGeometryContactScorer(size.width, size.height);
  assert.equal(score.cardContacts(after), 0);
  assert.equal(score.quality(after).crossings, 0);
  assert.deepEqual(geometry, before);
  // A foreign line through the destination must reject the shift.
  geometry.routes = [
    [
      "obstacle",
      {
        sourceHandle: "top",
        targetHandle: "bottom",
        points: [
          { x: 1200, y: -10 },
          { x: 1200, y: 280 },
        ],
      },
    ],
  ];
  assert.deepEqual(
    [...localFamilySpace(geometry, "anchor", size, new Set(["left-1"]))],
    [],
  );
});

test("extra-link endpoints and legacy sibling underlays are fixed, never detached", () => {
  const { input, next, geometry } = crowdedFamily();
  const link = { type: "godparent" as const, from: "left-1", to: "right-1" };
  assert.equal(
    localTreeLayout(
      { ...next, links: [link] },
      { ...input, links: [link] },
      geometry,
      size,
    ),
    undefined,
  );
  geometry.routes = [
    [
      JSON.stringify(["godparent", "left-1", "right-1"]),
      {
        sourceHandle: "top",
        targetHandle: "top",
        points: [
          { x: -198, y: -100 },
          { x: 418, y: -100 },
        ],
      },
    ],
  ];
  assert.equal(localTreeLayout(next, input, geometry, size), undefined);
  geometry.routes = [["unknown-legacy-key", geometry.routes[0][1]]];
  assert.equal(localTreeLayout(next, input, geometry, size), undefined);
  geometry.routes = [];
  geometry.siblingGroups = [
    {
      id: "legacy",
      members: ["left-1", "right-1"],
      x: -308,
      y: 0,
      width: 836,
      height: 264,
    },
  ];
  assert.equal(localTreeLayout(next, input, geometry, size), undefined);
});

test("packing obeys the block budget and rejects malformed or oversized routes", () => {
  const tooWide = crowdedFamily(205, 9);
  assert.equal(
    localTreeLayout(tooWide.next, tooWide.input, tooWide.geometry, size),
    undefined,
  );
  for (const scenario of ["dangling", "huge", "nan"]) {
    const { geometry } = crowdedFamily();
    if (scenario === "dangling") geometry.branches![0].source = "missing";
    else
      geometry.routes = [
        [
          "obstacle",
          {
            sourceHandle: "top",
            targetHandle: "bottom",
            points: [
              { x: scenario === "nan" ? NaN : -1e12, y: -100 },
              { x: 1e12, y: -100 },
            ],
          },
        ],
      ];
    assert.deepEqual([...localFamilySpace(geometry, "anchor", size)], []);
  }
});

test("a later blocked child discards the entire shifted plan without changing history", () => {
  const { input, next, geometry } = crowdedFamily();
  // All candidate new child slots are inside a different generation's cards.
  const children = Array.from({ length: 18 }, (_, i) =>
    person(`existing-child-${i}`, ["right-1", "neighbor-partner"]),
  );
  input.people.push(...children);
  next.people.push(...children, person("new-child", ["anchor", "partner"]));
  const band = {
    level: 1,
    targetY: 444,
    minY: 414,
    maxY: 474,
    members: children.map((p) => p.id),
  };
  geometry.generationBands!.push(band);
  children.forEach((p, i) => {
    geometry.positions.push([p.id, { x: -2700 + i * 308, y: 444 }]);
    geometry.occurrences!.push({
      id: p.id,
      personId: p.id,
      block: `person:${JSON.stringify(p.id)}`,
    });
  });
  const snapshot = structuredClone(geometry);
  assert.equal(localTreeLayout(next, input, geometry, size), undefined);
  assert.deepEqual(geometry, snapshot);
});
