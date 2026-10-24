import test from "node:test";
import assert from "node:assert/strict";
import ELK from "elkjs/lib/elk.bundled.js";
import { localTreeLayout } from "../src/domain/local-tree-layout.ts";
import { unionGeometry, createGeometryContactScorer } from "../src/domain/union-layout.ts";
import { person } from "./layout-fixtures.ts";
import type { TreeGeometry } from "../src/domain/tree-layout.ts";
import { MAX_LOCAL_LAYOUT_PEOPLE } from "../src/domain/tree-layout-constants.ts";

const size = { width: 220, height: 264 };
const people = [person("a", [], ["b"]), person("b", [], ["a"]), person("c", ["a", "b"])];
const input = { people, links: [] };
const layout = (reverse = false) => { const elk = new ELK(); return unionGeometry(people, g => elk.layout(g), reverse, [], size); };
const dataEdges = (geometry: TreeGeometry) => new Set(geometry.branches!.flatMap(b => b.relations.map(r => JSON.stringify(r))));

for (const reverse of [false, true]) test(`a leaf fits a free slot without moving any existing card (reverse=${reverse})`, async () => {
  const before = await layout(reverse), snapshot = structuredClone(before);
  const edited = { people: [...people, person("d", ["a", "b"])], links: [] };
  const result = localTreeLayout(edited, input, before, size);
  assert.equal(result?.kind, "local");
  const after = result!.geometry;
  assert.deepEqual(after.positions.filter(([id]) => id !== "d"), before.positions);
  assert.equal(after.positions.length, 4);
  assert.deepEqual(new Set(after.occurrences!.map(o => o.personId)), new Set(edited.people.map(p => p.id)));
  assert.deepEqual(dataEdges(after), new Set([...dataEdges(before), ...["a", "b"].map(from => JSON.stringify({ from, to: "d", type: "parent" }))]));
  assert.equal(after.generationBands!.find(b => b.members.includes("d"))!.level, 1);
  const score = createGeometryContactScorer(size.width, size.height);
  assert.equal(score.cardOverlaps(after), 0);
  assert.equal(score.cardContacts(after), 0);
  assert.deepEqual([score.quality(after).contacts, score.quality(after).crossings], [0, 0]);
  assert.deepEqual(before, snapshot);
  const restored = localTreeLayout(input, edited, after, size);
  assert.equal(restored?.kind, "local");
  assert.deepEqual(restored!.geometry.positions, before.positions);
  assert.deepEqual(dataEdges(restored!.geometry), dataEdges(before));
});

test("dates reuse generation geometry, but unrelated history, new unions and changed ancestry do not", async () => {
  const before = await layout();
  const dated = { ...input, people: people.map(p => ({ ...p, birth: "1900" })) };
  assert.equal(localTreeLayout(dated, input, before, size)?.geometry, before);
  assert.equal(localTreeLayout({ ...input, people: [...people].reverse() }, input, before, size), undefined);
  assert.equal(localTreeLayout(dated, { people: [person("unavailable")], links: [] }, before, size), undefined);
  assert.equal(localTreeLayout(dated, input, { ...before, mode: "timeline" }, size), undefined);
  assert.equal(localTreeLayout(dated, input, before, { ...size, height: 84 }), undefined);
  assert.equal(localTreeLayout({ ...input, people: people.map(p => p.id === "c" ? { ...p, parents: ["a"] } : p) }, input, before, size), undefined);
  const remarriage = { ...input, people: [...people.map(p => p.id === "a" ? { ...p, spouses: ["b", "d"] } : p), person("d", [], ["a"])] };
  assert.equal(localTreeLayout(remarriage, input, before, size), undefined);
});

test("a new leaf cannot cover an old route or cross an unrelated family", async () => {
  const before = await layout();
  const band = before.generationBands!.find(b => b.level === 1)!;
  const blocked: TreeGeometry = { ...before, routes: [["blocked", { sourceHandle: "right", targetHandle: "left",
    points: [{ x: -10000, y: band.targetY + 30 }, { x: 10000, y: band.targetY + 30 }] }]] };
  assert.equal(localTreeLayout({ ...input, people: [...people, person("d", ["a", "b"])] }, input, blocked, size), undefined);
  assert.deepEqual(blocked.positions, before.positions);
});

test("removing a final child of unmarried parents must rebuild the changed union", async () => {
  const source = { people: [person("a"), person("b"), person("c", ["a", "b"])], links: [] };
  const elk = new ELK();
  const before = await unionGeometry(source.people, g => elk.layout(g), false, [], size);
  assert.equal(localTreeLayout({ people: source.people.slice(0, 2), links: [] }, source, before, size), undefined);
});

test("a married couple gains its first child without moving old cards in either direction", async () => {
  const source = { people: people.slice(0, 2), links: [] };
  for (const reverse of [false, true]) {
    const elk = new ELK();
    const before = await unionGeometry(source.people, g => elk.layout(g), reverse, [], size);
    const result = localTreeLayout(input, source, before, size);
    assert.equal(result?.kind, "local");
    assert.deepEqual(result!.geometry.positions.slice(0, 2), before.positions);
    assert.deepEqual(result!.geometry.generationBands!.map(b => b.level), [0, 1]);
    assert.equal(createGeometryContactScorer(size.width, size.height).cardContacts(result!.geometry), 0);
  }
});

test("repeated leaf additions/removals retain identity, routes and generation constraints", async () => {
  const initial = await layout();
  let history = input, geometry = initial;
  for (let i = 0; i < 4; i++) {
    const next = { ...history, people: [...history.people, person(`leaf-${i}`, ["a", "b"])] };
    const result = localTreeLayout(next, history, geometry, size);
    assert.equal(result?.kind, "local");
    assert.deepEqual(result!.geometry.positions.slice(0, geometry.positions.length), geometry.positions);
    history = next; geometry = result!.geometry;
  }
  for (let i = 3; i >= 0; i--) {
    const next = { ...history, people: history.people.filter(p => p.id !== `leaf-${i}`) };
    const result = localTreeLayout(next, history, geometry, size);
    assert.equal(result?.kind, "local");
    history = next; geometry = result!.geometry;
  }
  assert.deepEqual(geometry.positions, initial.positions);
  assert.deepEqual(dataEdges(geometry), dataEdges(initial));
});

test("budgets, malformed history and structural batches always request a full solve", async () => {
  const before = await layout();
  const structuralBatch = { ...input, people: [...people, person("d", ["a", "b"]), person("e", ["d"])] };
  assert.equal(localTreeLayout(structuralBatch, input, before, size), undefined);
  assert.equal(localTreeLayout(input, input, { ...before, positions: [...before.positions, before.positions[0]] }, size), undefined);
  assert.equal(localTreeLayout(input, input, { ...before, positions: before.positions.map(([id, p]) => [id, { ...p, x: NaN }]) }, size), undefined);
  const tooMany = { people: Array.from({ length: MAX_LOCAL_LAYOUT_PEOPLE + 1 }, (_, i) => person(`p-${i}`)), links: [] };
  assert.equal(localTreeLayout(tooMany, input, before, size), undefined);
  assert.equal(localTreeLayout({ ...input, links: [{ from: "a", to: "c", type: "godparent" }] }, input, before, size), undefined);
});
