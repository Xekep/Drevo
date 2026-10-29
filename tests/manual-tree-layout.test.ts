import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import {
  unionGeometry,
  createGeometryContactScorer,
} from "../src/domain/union-layout.ts";
import { moveDisplayedFamily } from "../src/domain/manual-tree-layout.ts";
import { placedFamilyRows } from "../src/domain/local-family-order.ts";
import { routeKey } from "../src/domain/edge-routing.ts";

for (const reverse of [false, true])
  test(`manual horizontal placement preserves couples, generations and recorded data (${reverse})`, async () => {
    const people = [
      { id: "root", birth: "1900", parents: [], spouses: ["partner"] },
      { id: "partner", birth: "1902", parents: [], spouses: ["root"] },
      { id: "child", birth: "1930", parents: ["root", "partner"], spouses: [] },
      { id: "other", birth: "1905", parents: [], spouses: [] },
    ];
    const links = [{ from: "other", to: "child", type: "godparent" as const }];
    const engine = new ELK(),
      size = { width: 220, height: 264 };
    const original = await unionGeometry(
      people,
      (g) => engine.layout(g),
      reverse,
      links,
      size,
    );
    const snapshot = structuredClone(original),
      inputs = structuredClone(people);
    const positions = new Map(original.positions);
    const delta =
      Math.min(...original.positions.map(([, point]) => point.x)) -
      positions.get("root")!.x -
      1000;
    const moved = moveDisplayedFamily(original, "root", delta, true, links);
    const result = new Map(moved.positions);
    assert.equal(result.get("root")!.x - positions.get("root")!.x, delta);
    assert.equal(result.get("partner")!.x - positions.get("partner")!.x, delta);
    for (const [id, point] of original.positions) {
      assert.equal(result.get(id)!.y, point.y);
      if (!["root", "partner"].includes(id))
        assert.deepEqual(result.get(id), point);
    }
    assert.deepEqual(moved.generationBands, original.generationBands);
    assert.deepEqual(moved.occurrences, original.occurrences);
    assert.deepEqual(
      moved.branches?.map((b) => b.relations),
      original.branches?.map((b) => b.relations),
    );
    assert.equal(moved.routes!.length, original.routes!.length);
    assert.equal(moved.routes![0][0], routeKey(links[0]));
    assert.equal(createGeometryContactScorer(220, 264).cardOverlaps(moved), 0);
    const rows = placedFamilyRows(original, size),
      root = rows.flat().find((b) => b.members.includes("root"))!,
      other = rows.flat().find((b) => b.members.includes("other"))!;
    const drop = moveDisplayedFamily(
      original,
      "root",
      other.x - root.x,
      true,
      links,
    );
    assert.equal(
      createGeometryContactScorer(220, 264).cardOverlaps(drop),
      0,
      "a drop snaps outside occupied household space",
    );
    const preview = moveDisplayedFamily(original, "root", other.x - root.x);
    assert.equal(
      new Map(preview.positions).get("root")!.x - positions.get("root")!.x,
      other.x - root.x,
    );
    assert.equal(moveDisplayedFamily(original, "root", NaN), original);
    assert.equal(moveDisplayedFamily(original, "unknown", 20), original);
    assert.deepEqual(original, snapshot);
    assert.deepEqual(people, inputs);
  });
