import test from "node:test";
import assert from "node:assert/strict";
import { spaceFamilyRows } from "../src/domain/family-row-spacing.ts";
import { createGeometryContactScorer } from "../src/domain/union-layout.ts";
import { placedFamilyRows } from "../src/domain/local-family-order.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";

test("readability spacing separates whole couples without widening their internal gap", () => {
  const size = { width: 220, height: 264 };
  const ids = ["a", "b", "c", "d"];
  const geometry: TreeGeometry = { mode: "generations", reverse: false, start: 1700, offset: 0, nodeSize: size,
    positions: ids.map((id, i) => [id, { x: [0, 252, 536, 788][i], y: 0 }]),
    occurrences: ids.map((id, i) => ({ id, personId: id, block: i < 2 ? "first" : "second" })),
    generationBands: [{ level: 0, targetY: 0, minY: -30, maxY: 30, members: ids }],
    branches: [0, 2].map((i) => ({ id: `pair:${i}`, union: `union:${i}`, source: ids[i], target: ids[i + 1],
      relations: [{ from: ids[i], to: ids[i + 1], type: "spouse" }],
      route: { sourceHandle: "right", targetHandle: "left", points: [
        { x: [220, 0, 756][i], y: 132 }, { x: [252, 0, 788][i], y: 132 },
      ] } })),
  };
  const saved = structuredClone(geometry), scoring = createGeometryContactScorer(220, 264);
  const score = (g: TreeGeometry) => ({ ...scoring.quality(g), cardHits: scoring.cardContacts(g), overlaps: scoring.cardOverlaps(g) });
  const result = spaceFamilyRows(geometry, size, score);
  const [row] = placedFamilyRows(result, size);
  assert.equal(row[1].x - row[0].x - row[0].width, 88);
  const positions = new Map(result.positions);
  for (const [a, b] of [["a", "b"], ["c", "d"]]) {
    assert.equal(positions.get(b)!.x - positions.get(a)!.x, 252);
    assert.equal(positions.get(a)!.y, 0);
  }
  assert.equal(score(result).contacts, 0);
  assert.equal(score(result).cardHits, 0);
  assert.equal(score(result).overlaps, 0);
  assert.deepEqual(result.branches!.map((b) => b.relations), geometry.branches!.map((b) => b.relations));
  assert.deepEqual(geometry, saved);
  assert.equal(spaceFamilyRows({ ...geometry, positions: Array.from({ length: 1201 }, (_, i) => [String(i), { x: i * 300, y: 0 }]) }, size,
    () => { throw new Error("oversized graphs must skip the spacing search"); }).positions.length, 1201);
});
