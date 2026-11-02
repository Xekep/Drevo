import test from "node:test";
import assert from "node:assert/strict";
import {
  familyUnions,
  createGeometryContactScorer,
  type UnionBranch,
} from "../src/domain/union-layout.ts";
import { localUnionRoutes } from "../src/domain/union-groups.ts";
import type { LayoutPerson, TreeGeometry } from "../src/domain/tree-layout.ts";
import { routeRelationships, routeKey } from "../src/domain/edge-routing.ts";
import {
  jointFamilyMoves,
  optimizeJointFamilyOrder,
  preferJointFamilyLayout,
} from "../src/domain/joint-family-order.ts";

const size = { width: 220, height: 264 };
function fixture(reverse: boolean, sharedAncestor = false) {
  const households: [string[], number, number][] = [
    [["a0", "a1"], 1800, 0],
    [["b0", "b1"], 3300, 0],
    [["bChild1", "bMate"], 0, 500],
    [["aChild1", "aMate"], 1700, 500],
    [["aChild2", "bChild2"], 2600, 500],
    [["bChild3"], 3100, 500],
    [["bChild4", "bMate4"], 3500, 500],
    [["gb1"], 0, 1000],
    [["ga1"], 1600, 1000],
    [["ga2"], 2000, 1000],
    [["gb4"], 3400, 1000],
  ];
  const ancestry: Record<string, string[]> = {
    aChild1: ["a0", "a1"],
    aChild2: ["a0", "a1"],
    bChild1: ["b0", "b1"],
    bChild2: ["b0", "b1"],
    bChild3: ["b0", "b1"],
    bChild4: ["b0", "b1"],
    ga1: ["aChild1", "aMate"],
    ga2: ["aChild1", "aMate"],
    gb1: ["bChild1", "bMate"],
    gb4: ["bChild4", "bMate4"],
  };
  if (sharedAncestor) {
    households.unshift([["ancestor0", "ancestor1"], 2400, -500]);
    ancestry.a0 = ["ancestor0", "ancestor1"];
    ancestry.b0 = ["ancestor0", "ancestor1"];
  }
  const people: LayoutPerson[] = households.flatMap(([members]) =>
    members.map((id) => ({
      id,
      birth: "",
      parents: ancestry[id] || [],
      spouses: members.filter((other) => other !== id),
    })),
  );
  const positions: TreeGeometry["positions"] = households.flatMap(
    ([members, x, y]) => members.map((id, i) => [id, { x: x + i * 252, y }]),
  );
  const points = new Map(positions),
    branches: UnionBranch[] = [];
  const families = familyUnions(people);
  families.forEach((family, i) => {
    const members = households.find(([members]) =>
      members.includes(family.members[0]),
    )![0];
    const origin = points.get(members[0])!;
    const local = localUnionRoutes(
      { id: family.id, members, families: [family] },
      size,
    ).families[0];
    const [source, target] = family.members;
    if (local.pair)
      branches.push({
        id: `pair:${family.id}`,
        union: family.id,
        source,
        target,
        relations: [{ type: "spouse", from: source, to: target }],
        route: {
          ...local.pair,
          points: local.pair.points.map((p) => ({
            x: p.x + origin.x,
            y: p.y + origin.y,
          })),
        },
      });
    for (const child of family.children) {
      const start = {
          x: origin.x + local.joint.x,
          y: origin.y + local.joint.y,
        },
        end = { x: points.get(child)!.x + 110, y: points.get(child)!.y },
        channel = origin.y + 330 + i * 4;
      branches.push({
        id: `child:${family.id}:${child}`,
        union: family.id,
        source,
        target: child,
        relations: family.members.map((from) => ({
          type: "parent",
          from,
          to: child,
        })),
        route: {
          sourceHandle: "bottom",
          targetHandle: "top",
          points: [
            start,
            { x: start.x, y: channel },
            { x: end.x, y: channel },
            end,
          ],
        },
      });
    }
  });
  const geometry: TreeGeometry = {
    mode: "generations",
    reverse,
    nodeSize: size,
    start: 1700,
    offset: 0,
    positions,
    branches,
    routes: [],
    blocks: [],
    occurrences: households.flatMap(([members]) =>
      members.map((id) => ({ id, personId: id, block: members.join(":") })),
    ),
    generationBands: (sharedAncestor
      ? [-500, 0, 500, 1000]
      : [0, 500, 1000]
    ).map((y, level) => ({
      level,
      targetY: y,
      minY: y - 30,
      maxY: y + 30,
      members: positions.filter(([, p]) => p.y === y).map(([id]) => id),
    })),
  };
  if (reverse) {
    for (const [, p] of positions) p.y = -p.y;
    for (const band of geometry.generationBands!) {
      const min = band.minY;
      band.targetY = -band.targetY;
      band.minY = -band.maxY;
      band.maxY = -min;
    }
    for (const branch of branches) {
      branch.route.points = branch.route.points.map((p) => ({
        x: p.x,
        y: size.height - p.y,
      }));
      for (const field of ["sourceHandle", "targetHandle"] as const)
        branch.route[field] =
          branch.route[field] === "top"
            ? "bottom"
            : branch.route[field] === "bottom"
              ? "top"
              : branch.route[field];
    }
  }
  return { people, geometry };
}
const scorer = () => {
  const s = createGeometryContactScorer(size.width, size.height);
  return (g: TreeGeometry) => ({
    ...s.quality(g),
    cardHits: s.cardContacts(g),
    overlaps: s.cardOverlaps(g),
  });
};
for (const reverse of [false, true])
  test(`joint family order moves both generations and preserves recorded relations (${reverse})`, () => {
    const { people, geometry } = fixture(reverse),
      before = structuredClone(geometry),
      score = scorer();
    const moves = jointFamilyMoves(geometry, size);
    assert.ok(moves.length > 0 && moves.length <= 6);
    const result = optimizeJointFamilyOrder(geometry, people, [], size, score);
    assert.ok(
      score(result).crossings < score(geometry).crossings,
      JSON.stringify([score(geometry), score(result)]),
    );
    assert.equal(score(result).overlaps, 0);
    assert.equal(score(result).cardHits, 0);
    assert.deepEqual(geometry, before);
    assert.deepEqual(
      new Set(result.positions.map(([id]) => id)),
      new Set(people.map((p) => p.id)),
    );
    const oldPoints = new Map(before.positions);
    for (const [id, p] of result.positions)
      assert.equal(p.y, oldPoints.get(id)!.y);
    assert.deepEqual(
      result.branches!.map((b) => [b.id, b.relations]),
      before.branches!.map((b) => [b.id, b.relations]),
    );
  });

test("joint order reroutes additional relationships against the accepted positions", () => {
  const { people, geometry } = fixture(false),
    score = scorer();
  const links = [
    { type: "sworn_sibling" as const, from: "bChild3", to: "bChild4" },
  ];
  geometry.routes = routeRelationships(
    people.map((p) => ({ ...p, parents: [], spouses: [] })),
    links,
    geometry.positions,
    size.width,
    size.height,
    new Set(),
    geometry.branches!.map((b) => ({ group: b.union, route: b.route })),
  );
  const result = optimizeJointFamilyOrder(geometry, people, links, size, score);
  assert.ok(
    score(result).crossings < score(geometry).crossings,
    JSON.stringify({ before: score(geometry), after: score(result) }),
  );
  assert.equal(score(result).cardHits, 0);
  assert.deepEqual(
    result.routes!.map(([id]) => id),
    links.map(routeKey),
  );
  const points = new Map(result.positions),
    route = result.routes![0][1];
  const source = points.get(links[0].from)!,
    target = points.get(links[0].to)!;
  const onCard = (
    p: { x: number; y: number },
    card: { x: number; y: number },
  ) =>
    p.x >= card.x &&
    p.x <= card.x + size.width &&
    p.y >= card.y &&
    p.y <= card.y + size.height;
  assert.ok(onCard(route.points[0], source));
  assert.ok(onCard(route.points.at(-1)!, target));
});

test("joint order skips families whose ancestors would receive conflicting shifts", () => {
  const { geometry } = fixture(false, true);
  assert.deepEqual(jointFamilyMoves(geometry, size), []);
});

test("joint acceptance rejects overlaps and skips oversized scenes", () => {
  const { people, geometry } = fixture(false),
    score = scorer();
  assert.equal(preferJointFamilyLayout(geometry, geometry, size, score), false);
  const improved = optimizeJointFamilyOrder(geometry, people, [], size, score);
  assert.equal(preferJointFamilyLayout(improved, geometry, size, score), true);
  const bad = structuredClone(improved);
  bad.positions[0][1] = { ...bad.positions[1][1] };
  assert.ok(score(bad).crossings < score(geometry).crossings);
  assert.ok(score(bad).overlaps > 0);
  assert.equal(preferJointFamilyLayout(bad, geometry, size, score), false);
  assert.deepEqual(
    jointFamilyMoves(
      {
        ...geometry,
        positions: Array.from({ length: 601 }, (_, i) => [
          String(i),
          { x: i * 300, y: 0 },
        ]),
      },
      size,
    ),
    [],
  );
});
