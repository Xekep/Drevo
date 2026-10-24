import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import { localTreeLayout } from "../src/domain/local-tree-layout.ts";
import { MAX_LOCAL_FAMILY_ADDITIONS } from "../src/domain/local-family-growth.ts";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { person } from "./layout-fixtures.ts";
import type { LayoutPerson, TreeGeometry } from "../src/domain/tree-layout.ts";

const size = { width: 220, height: 264 };
const source = {
  people: [person("parent"), person("anchor", ["parent"])],
  links: [],
};
const input = (count = 2) => ({
  people: [
    source.people[0],
    { ...source.people[1], spouses: ["partner"] },
    person("partner", [], ["anchor"]),
    ...Array.from({ length: count }, (_, i) =>
      person(`child-${i}`, ["anchor", "partner"]),
    ),
  ],
  links: [],
});
const geometry = async (people = source.people, reverse = false) => {
  const elk = new ELK();
  return unionGeometry(people, (g) => elk.layout(g), reverse, [], size);
};
const dataEdges = (g: TreeGeometry) =>
  new Set(
    g.branches!.flatMap((b) =>
      b.relations.map((r) =>
        JSON.stringify(
          r.type === "spouse"
            ? [r.type, ...[r.from, r.to].sort()]
            : [r.type, r.from, r.to],
        ),
      ),
    ),
  );
function verify(
  people: LayoutPerson[],
  before: TreeGeometry,
  after: TreeGeometry,
) {
  assert.deepEqual(
    after.positions.slice(0, before.positions.length),
    before.positions,
  );
  assert.deepEqual(
    new Set(after.occurrences!.map((o) => o.personId)),
    new Set(people.map((p) => p.id)),
  );
  assert.equal(new Set(after.positions.map(([id]) => id)).size, people.length);
  assert.deepEqual(
    dataEdges(after),
    new Set(
      people.flatMap((p) => [
        ...p.parents.map((parent) => JSON.stringify(["parent", parent, p.id])),
        ...p.spouses.map((spouse) =>
          JSON.stringify(["spouse", ...[p.id, spouse].sort()]),
        ),
      ]),
    ),
  );
  const score = createGeometryContactScorer(size.width, size.height);
  assert.equal(score.cardOverlaps(after), 0);
  assert.equal(score.cardContacts(after), 0);
  assert.equal(score.quality(after).crossings, 0);
  assert.equal(score.quality(after).contacts, 0);
  const bands = new Map(
    after.generationBands!.flatMap((b) =>
      b.members.map((id) => [id, b] as const),
    ),
  );
  for (const [id, point] of after.positions) {
    assert.ok(point.y >= bands.get(id)!.minY && point.y <= bands.get(id)!.maxY);
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
  for (const b of after.branches!)
    for (let i = 1; i < b.route.points.length; i++)
      assert.ok(
        b.route.points[i].x === b.route.points[i - 1].x ||
          b.route.points[i].y === b.route.points[i - 1].y,
      );
}

for (const reverse of [false, true])
  test(`a first family grows atomically, preserving the ancestor route (reverse=${reverse})`, async () => {
    const before = await geometry(source.people, reverse),
      snapshot = structuredClone(before);
    for (const count of [0, 1, 3]) {
      const next = input(count),
        original = structuredClone(next);
      const result = localTreeLayout(next, source, before, size);
      assert.equal(result?.kind, "local");
      verify(next.people, before, result!.geometry);
      assert.deepEqual(
        result!.geometry.branches!.find((b) => b.target === "anchor"),
        before.branches!.find((b) => b.target === "anchor"),
      );
      const couple = result!.geometry.blocks!.find((b) =>
        b.members.includes("partner"),
      )!;
      assert.equal(couple.width, 472);
      assert.ok(couple.members.includes("anchor"));
      assert.equal(
        result!.geometry.occurrences!.find((o) => o.id === "anchor")!.block,
        couple.id,
      );
      assert.equal(
        result!.geometry.occurrences!.find((o) => o.id === "partner")!.block,
        couple.id,
      );
      assert.deepEqual(next, original);
    }
    assert.deepEqual(before, snapshot);
  });

test("a sibling batch reuses one family trunk and rejects the entire batch if a later card is blocked", async () => {
  const base = input(1),
    before = await geometry(base.people);
  const next = input(4);
  const result = localTreeLayout(next, base, before, size);
  assert.equal(result?.kind, "local");
  verify(next.people, before, result!.geometry);
  const blocked: TreeGeometry = {
    ...before,
    routes: [
      [
        "barrier",
        {
          sourceHandle: "right" as const,
          targetHandle: "left" as const,
          points: [
            { x: -10000, y: before.generationBands!.at(-1)!.targetY + 20 },
            { x: 10000, y: before.generationBands!.at(-1)!.targetY + 20 },
          ],
        },
      ],
    ],
  };
  const original = structuredClone(blocked);
  assert.equal(localTreeLayout(next, base, blocked, size), undefined);
  assert.deepEqual(blocked, original);
});

test("the other side is tried when an existing route blocks a partner slot", async () => {
  const before = await geometry(),
    anchor = new Map(before.positions).get("anchor")!;
  const blocked: TreeGeometry = {
    ...before,
    routes: [
      [
        "barrier",
        {
          sourceHandle: "top",
          targetHandle: "bottom",
          points: [
            { x: anchor.x + size.width + 40, y: anchor.y - 20 },
            { x: anchor.x + size.width + 40, y: anchor.y + size.height + 20 },
          ],
        },
      ],
    ],
  };
  const next = input(0),
    result = localTreeLayout(next, source, blocked, size);
  assert.equal(result?.kind, "local");
  assert.ok(new Map(result!.geometry.positions).get("partner")!.x < anchor.x);
  verify(next.people, blocked, result!.geometry);
});

test("symmetric and one-sided partner records all produce one complete union", async () => {
  const before = await geometry();
  for (const drop of ["anchor", "partner"]) {
    const next = input(0);
    next.people = next.people.map((p) =>
      p.id === drop ? { ...p, spouses: [] } : p,
    );
    const result = localTreeLayout(next, source, before, size);
    assert.equal(result?.kind, "local");
    verify(next.people, before, result!.geometry);
  }
});

test("unknown ancestry, existing families, dangling extra links, alias collisions and oversized batches use a full solve", async () => {
  const before = await geometry();
  const oversized = input(MAX_LOCAL_FAMILY_ADDITIONS);
  assert.equal(localTreeLayout(oversized, source, before, size), undefined);
  const reparented = input();
  reparented.people = reparented.people.map((p) =>
    p.id === "anchor" ? { ...p, parents: [] } : p,
  );
  assert.equal(localTreeLayout(reparented, source, before, size), undefined);
  const withAncestry = input();
  withAncestry.people.push(person("new-parent"));
  withAncestry.people = withAncestry.people.map((p) =>
    p.id === "partner" ? { ...p, parents: ["new-parent"] } : p,
  );
  assert.equal(localTreeLayout(withAncestry, source, before, size), undefined);
  const links = [{ from: "parent", to: "partner", type: "godparent" as const }];
  assert.equal(
    localTreeLayout({ ...input(), links }, { ...source, links }, before, size),
    undefined,
  );
  const alias: TreeGeometry = {
    ...before,
    positions: [...before.positions, ["partner", { x: 2000, y: 0 }]],
    occurrences: [
      ...before.occurrences!,
      { id: "partner", personId: "parent", block: "reference-parent" },
    ],
  };
  assert.equal(localTreeLayout(input(), source, alias, size), undefined);
  const withChild = {
    people: [...source.people, person("existing-child", ["anchor"])],
    links: [],
  };
  const withChildGeometry = await geometry(withChild.people);
  assert.equal(
    localTreeLayout(
      { ...input(), people: [...input().people, withChild.people.at(-1)!] },
      withChild,
      withChildGeometry,
      size,
    ),
    undefined,
  );
});

test("blocking a child's generation does not publish the already-placed partner", async () => {
  const before = await geometry(),
    anchor = new Map(before.positions).get("anchor")!;
  const obstacle: TreeGeometry = {
    ...before,
    routes: [
      [
        "blocked-children",
        {
          sourceHandle: "right",
          targetHandle: "left",
          points: [
            { x: -10000, y: anchor.y + 380 },
            { x: 10000, y: anchor.y + 380 },
          ],
        },
      ],
    ],
  };
  const snapshot = structuredClone(obstacle);
  assert.equal(localTreeLayout(input(), source, obstacle, size), undefined);
  assert.deepEqual(obstacle, snapshot);
  assert.equal(obstacle.positions.length, source.people.length);
});
