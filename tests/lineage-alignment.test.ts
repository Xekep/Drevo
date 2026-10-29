import test from "node:test";
import assert from "node:assert/strict";
import type { TreeGeometry, LayoutPerson } from "../src/domain/tree-layout.ts";
import { alignFamilyLineages } from "../src/domain/lineage-alignment.ts";
import { familyAxisQuality } from "../src/domain/family-axis.ts";
import {
  createGeometryContactScorer,
  unionGeometry,
} from "../src/domain/union-layout.ts";
import { canUseFamilyLayoutHistory } from "../src/domain/family-layout-history.ts";
import ELK from "elkjs/lib/elk.bundled.js";
import { routeRelationships } from "../src/domain/edge-routing.ts";
import { optimizeDisplayedTree } from "../src/domain/optimize-tree-layout.ts";

const size = { width: 220, height: 264 };
function staircase(reverse: boolean) {
  const people: LayoutPerson[] = [],
    geometry: TreeGeometry = {
      mode: "generations",
      reverse,
      start: 1700,
      offset: 0,
      nodeSize: size,
      positions: [],
      occurrences: [],
      blocks: [],
      generationBands: [],
      branches: [],
      routes: [],
    };
  for (let i = 0; i < 6; i++) {
    const x = i * 126,
      y = reverse ? 2500 - i * 500 : i * 500;
    const a = `child-${i}`,
      b = `partner-${i}`,
      block = `household-${i}`;
    people.push(
      {
        id: a,
        birth: "",
        parents: i ? [`child-${i - 1}`, `partner-${i - 1}`] : [],
        spouses: [b],
      },
      { id: b, birth: "", parents: [], spouses: [a] },
    );
    geometry.positions.push([a, { x, y }], [b, { x: x + 252, y }]);
    geometry.occurrences!.push(
      { id: a, personId: a, block },
      { id: b, personId: b, block },
    );
    geometry.blocks!.push({
      id: block,
      members: [a, b],
      x,
      y,
      width: 472,
      height: 264,
    });
    geometry.generationBands!.push({
      level: i,
      targetY: y,
      minY: y - 30,
      maxY: y + 30,
      members: [a, b],
    });
    geometry.branches!.push({
      id: `pair:${i}`,
      source: a,
      target: b,
      union: block,
      relations: [{ type: "spouse", from: a, to: b }],
      route: {
        sourceHandle: "right",
        targetHandle: "left",
        points: [
          { x: x + 220, y: y + 132 },
          { x: x + 252, y: y + 132 },
        ],
      },
    });
    if (i) {
      const priorY = reverse ? y + 500 : y - 500;
      geometry.branches!.push({
        id: `child:${i}`,
        source: `child-${i - 1}`,
        target: a,
        union: `household-${i - 1}`,
        relations: [
          { type: "parent", from: `child-${i - 1}`, to: a },
          { type: "parent", from: `partner-${i - 1}`, to: a },
        ],
        route: {
          sourceHandle: reverse ? "top" : "bottom",
          targetHandle: reverse ? "bottom" : "top",
          points: [
            { x: x + 110, y: priorY + (reverse ? 0 : 264) },
            { x: x + 110, y: y + (reverse ? 264 : 0) },
          ],
        },
      });
    }
  }
  return { people, geometry };
}
function scoring() {
  const value = createGeometryContactScorer(220, 264);
  return (g: TreeGeometry) => ({
    ...value.quality(g),
    cardHits: value.cardContacts(g),
    overlaps: value.cardOverlaps(g),
  });
}
const identities = (g: TreeGeometry) =>
  g.branches!.flatMap((b) => b.relations.map((r) => JSON.stringify(r))).sort();

for (const reverse of [false, true]) {
  test(`a lineage with unknown partners stays near one vertical axis without longer arrows (${reverse})`, () => {
    const { people, geometry } = staircase(reverse),
      saved = structuredClone(geometry),
      score = scoring();
    const after = alignFamilyLineages(geometry, people, [], size, score);
    const beforeAxis = familyAxisQuality(geometry, size),
      afterAxis = familyAxisQuality(after, size);
    assert.ok(afterAxis.lineageSpan <= 126 + 0.01);
    assert.ok(afterAxis.lineageDrift < beforeAxis.lineageDrift);
    assert.equal(score(after).length, score(geometry).length);
    assert.equal(score(after).bends, 0);
    assert.equal(score(after).crossings, 0);
    assert.equal(score(after).cardHits, 0);
    assert.equal(score(after).overlaps, 0);
    for (const edge of after.branches!.filter((b) => b.id.startsWith("child:")))
      assert.equal(edge.route.points[0].x, edge.route.points.at(-1)!.x);
    assert.deepEqual(
      after.positions.map(([id, p]) => [id, p.y]),
      geometry.positions.map(([id, p]) => [id, p.y]),
    );
    assert.deepEqual(identities(after), identities(geometry));
    assert.deepEqual(after.generationBands, geometry.generationBands);
    assert.deepEqual(geometry, saved);
    const optimized = optimizeDisplayedTree(geometry, people, [], "routing");
    assert.equal(optimized.optimization.changed, true);
    assert.ok(
      familyAxisQuality(optimized.geometry, size).lineageSpan <= 126 + 0.01,
    );
    assert.deepEqual(
      alignFamilyLineages(after, people, [], size, score),
      after,
    );
  });

  test(`fixed neighboring families constrain a lineage projection (${reverse})`, () => {
    const { people, geometry } = staircase(reverse),
      y = geometry.positions.find(([id]) => id === "child-3")![1].y;
    geometry.positions.push(["fixed", { x: 0, y }]);
    geometry.occurrences!.push({
      id: "fixed",
      personId: "fixed",
      block: "fixed",
    });
    geometry.generationBands![3].members.push("fixed");
    people.push({ id: "fixed", birth: "", parents: [], spouses: [] });
    const after = alignFamilyLineages(geometry, people, [], size, scoring());
    assert.deepEqual(
      after.positions.find(([id]) => id === "fixed"),
      ["fixed", { x: 0, y }],
    );
    assert.equal(scoring()(after).overlaps, 0);
    assert.equal(scoring()(after).cardHits, 0);
  });

  test(`lineage alignment preserves and reroutes supplemental relationships (${reverse})`, () => {
    const { people, geometry } = staircase(reverse);
    const links = [
      { type: "godparent" as const, from: "partner-0", to: "child-5" },
    ];
    geometry.routes = routeRelationships(
      people.map((p) => ({ ...p, parents: [], spouses: [] })),
      links,
      geometry.positions,
      220,
      264,
      new Set(),
      geometry.branches!.map((b) => ({ group: b.union, route: b.route })),
    );
    const before = structuredClone(geometry),
      score = scoring();
    const after = alignFamilyLineages(geometry, people, links, size, score);
    assert.equal(after.routes!.length, 1);
    assert.equal(after.routes![0][0], before.routes![0][0]);
    assert.ok(score(after).cardHits <= score(before).cardHits);
    assert.equal(score(after).overlaps, 0);
    assert.deepEqual(identities(after), identities(before));
    assert.deepEqual(geometry, before);
  });

  test(`adding an ancestor beyond 200 people retains horizontal slots (${reverse})`, async () => {
    const people: LayoutPerson[] = [
      { id: "root", birth: "1900", parents: [], spouses: [] },
      { id: "child", birth: "1930", parents: ["root"], spouses: [] },
    ];
    for (let i = 0; i < 220; i++)
      people.push({
        id: `independent-${i}`,
        birth: "",
        parents: [],
        spouses: [],
      });
    const elk = new ELK(),
      before = await unionGeometry(
        people,
        (g) => elk.layout(g),
        reverse,
        [],
        size,
      );
    const edited = [
      ...people.map((p) =>
        p.id === "root" ? { ...p, parents: ["ancestor"] } : p,
      ),
      { id: "ancestor", birth: "1870", parents: [], spouses: [] },
    ];
    assert.equal(
      canUseFamilyLayoutHistory(edited, before, reverse, size),
      true,
    );
    const after = await unionGeometry(
      edited,
      (g) => elk.layout(g),
      reverse,
      [],
      size,
      before,
    );
    const positions = new Map(after.positions);
    for (const [id, point] of before.positions)
      assert.equal(positions.get(id)!.x, point.x, id);
    assert.equal(scoring()(after).overlaps, 0);
    assert.equal(scoring()(after).cardHits, 0);
    const bulk = edited.map((p, index) =>
      index >= 2 && index < 12 ? { ...p, parents: ["root"] } : p,
    );
    assert.equal(canUseFamilyLayoutHistory(bulk, before, reverse, size), false);
    const invalid = structuredClone(before);
    invalid.positions[0][1].x = NaN;
    assert.equal(
      canUseFamilyLayoutHistory(edited, invalid, reverse, size),
      false,
    );
    assert.equal(
      canUseFamilyLayoutHistory(
        [
          ...edited,
          ...Array.from({ length: 200 }, (_, i) => ({
            id: `bulk-${i}`,
            birth: "",
            parents: [],
            spouses: [],
          })),
        ],
        before,
        reverse,
        size,
      ),
      false,
    );
  });
}
