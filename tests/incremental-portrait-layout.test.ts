import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { treeNodeSize } from "../src/domain/tree-layout-constants.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { randomFamily } from "./layout-fixtures.ts";

// Generated structure: a wide recent family with a much deeper founder branch.
// No records, identifiers or dates from a user's archive are stored here.
function unevenFamily() {
  const people = randomFamily(4, 3);
  people.find((p) => p.id === "f-0")!.parents = ["deep-0"];
  for (let i = 0; i < 10; i++)
    people.push({
      id: `deep-${i}`,
      birth: "",
      spouses: [],
      parents: i < 9 ? [`deep-${i + 1}`] : [],
    });
  return people;
}
function displacement(before: TreeGeometry, after: TreeGeometry) {
  const old = new Map(before.positions);
  const shifts = after.positions
    .filter(([id]) => old.has(id))
    .map(([id, p]) => p.x - old.get(id)!.x)
    .sort((a, b) => a - b);
  const translation = shifts[Math.floor(shifts.length / 2)];
  return (
    shifts.reduce((sum, x) => sum + Math.abs(x - translation), 0) /
    shifts.length
  );
}
const relationKeys = (g: TreeGeometry) =>
  [
    ...new Set(
      g.branches!.flatMap((b) => b.relations.map((r) => JSON.stringify(r))),
    ),
  ].sort();

for (const reverse of [false, true])
  test(`local portrait edits keep distant families stable (reverse=${reverse})`, async () => {
    const people = unevenFamily(),
      original = structuredClone(people),
      size = treeNodeSize();
    const engine = new ELK({ algorithms: ["layered"] });
    const scorer = createGeometryContactScorer(size.width, size.height);
    const before = await unionGeometry(
      people,
      (g) => engine.layout(g),
      reverse,
      [],
      size,
    );
    const beforeCopy = structuredClone(before);
    assert.equal(people.length, 100);
    for (const edit of ["ancestor", "child"]) {
      const edited =
        edit === "ancestor"
          ? [
              ...people.map((p) =>
                p.id === "f-1" ? { ...p, parents: ["new-ancestor"] } : p,
              ),
              { id: "new-ancestor", birth: "", parents: [], spouses: [] },
            ]
          : [
              ...people,
              {
                id: "new-child",
                birth: "",
                spouses: [],
                parents: [
                  people.find((p) => p.parents.length && p.spouses.length)!.id,
                ],
              },
            ];
      const fresh = await unionGeometry(
        edited,
        (g) => engine.layout(g),
        reverse,
        [],
        size,
      );
      let calls = 0;
      const after = await unionGeometry(
        edited,
        (g) => {
          calls++;
          return engine.layout(g);
        },
        reverse,
        [],
        size,
        before,
      );
      assert.ok(calls <= 8, "six seeds and at most two historical candidates");
      assert.ok(displacement(before, after) <= size.width / 8, edit);
      const quality = scorer.quality(after);
      assert.ok(quality.contacts <= scorer.quality(before).contacts, edit);
      assert.ok(quality.crossings <= scorer.quality(before).crossings, edit);
      assert.ok(quality.contacts <= scorer.quality(fresh).contacts + 2, edit);
      assert.equal(scorer.cardContacts(after), 0);
      assert.equal(scorer.cardOverlaps(after), 0);
      assert.deepEqual(
        after.occurrences!.map((p) => p.personId).sort(),
        edited.map((p) => p.id).sort(),
      );
      assert.deepEqual(relationKeys(after), relationKeys(fresh));
      const levels = (g: TreeGeometry) =>
        g.generationBands!.map((band) => [
          band.level,
          [...band.members].sort(),
        ]);
      assert.deepEqual(levels(after), levels(fresh));
      const positions = new Map(after.positions);
      for (const branch of after.branches!) {
        for (let i = 1; i < branch.route.points.length; i++) {
          const a = branch.route.points[i - 1],
            b = branch.route.points[i];
          assert.ok(a.x === b.x || a.y === b.y, "orthogonal ancestry");
        }
        if (!branch.id.startsWith("child:")) continue;
        const target = positions.get(branch.target)!,
          end = branch.route.points.at(-1)!;
        assert.equal(end.x, target.x + size.width / 2);
        assert.equal(end.y, target.y + (reverse ? size.height : 0));
      }
    }
    assert.deepEqual(people, original);
    assert.deepEqual(before, beforeCopy);
  });
