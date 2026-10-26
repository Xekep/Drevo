import assert from "node:assert/strict";
import test from "node:test";
import {
  placeSpatialCards,
  spatialCardBounds,
  SPATIAL_CARD_PROBES,
  SPATIAL_FRAME_PROBES,
  type ScreenCard,
} from "../src/domain/spatial-card-layout.ts";
const card = (id: string, x = 250, y = 250, distance = 1000): ScreenCard => ({
  id,
  x,
  y,
  distance,
  size: 112,
});
function overlaps(a: ScreenCard, b: ScreenCard) {
  const x = spatialCardBounds(a),
    y = spatialCardBounds(b);
  return (
    x.left < y.right && x.right > y.left && x.top < y.bottom && x.bottom > y.top
  );
}
test("coincident projections separate without moving their anchors or hiding people", () => {
  const input = [
    card("near", 250, 250, 500),
    card("far", 250, 250, 1000),
    card("third", 250, 250, 1500),
  ];
  const saved = structuredClone(input),
    result = placeSpatialCards(input, 600, 600);
  assert.equal(result.unresolved, 0);
  assert.deepEqual(
    result.cards.map((c) => c.id),
    input.map((c) => c.id),
  );
  assert.equal(result.cards[0].x, 250);
  for (let i = 0; i < result.cards.length; i++) {
    assert.equal(result.cards[i].anchorX, 250);
    assert.equal(result.cards[i].anchorY, 250);
    assert.ok(result.cards[i].size >= 18);
    for (const other of result.cards.slice(i + 1))
      assert.equal(overlaps(result.cards[i], other), false);
  }
  assert.deepEqual(input, saved);
});
test("an unobstructed scene retains exact card positions and scale", () => {
  const input = [card("a", 100, 100), card("b", 400, 300)];
  assert.deepEqual(
    placeSpatialCards(input, 600, 600).cards.map(
      ({ id, x, y, size, distance }) => ({ id, x, y, size, distance }),
    ),
    input,
  );
});
test("a focused far card stays at its real anchor; results are independent of input order", () => {
  const input = [card("a", 180, 200, 100), card("b", 180, 200, 1000)];
  const one = placeSpatialCards(input, 390, 650, new Map(), "b");
  assert.equal(one.cards[1].x, 180);
  assert.equal(overlaps(one.cards[0], one.cards[1]), false);
  assert.deepEqual(
    new Map(one.cards.map((c) => [c.id, c])),
    new Map(
      placeSpatialCards(
        [...input].reverse(),
        390,
        650,
        new Map(),
        "b",
      ).cards.map((c) => [c.id, c]),
    ),
  );
});
test("cached offsets remain stable and packing stays within mobile viewport", () => {
  const input = Array.from({ length: 8 }, (_, i) =>
    card(String(i), 195, 300, 100 + i),
  );
  const first = placeSpatialCards(input, 390, 650);
  const offsets = new Map(
    first.cards.map((c, i) => [
      c.id,
      {
        dx: c.x - c.anchorX,
        dy: c.y - c.anchorY,
        scale: c.size / input[i].size,
      },
    ]),
  );
  const next = placeSpatialCards(input, 390, 650, offsets);
  assert.deepEqual(next.cards, first.cards);
  for (const c of next.cards) {
    const b = spatialCardBounds(c);
    assert.ok(b.left >= 0 && b.right <= 390 && b.top >= 0 && b.bottom <= 650);
  }
});
test("a crowded overview uses free space beyond the nearest ring", () => {
  const input = Array.from({ length: 80 }, (_, i) => ({
    id: String(i),
    x: 640 + Math.sin(i * 2.399) * Math.sqrt(i) * 4,
    y: 360 + Math.cos(i * 2.399) * Math.sqrt(i) * 3,
    size: 40,
    distance: 1000 + i,
  }));
  const result = placeSpatialCards(input, 1280, 650);
  assert.equal(result.unresolved, 0);
  for (let i = 0; i < result.cards.length; i++) {
    const c = result.cards[i];
    assert.ok(Math.hypot(c.x - c.anchorX, c.y - c.anchorY) <= 220);
    for (const other of result.cards.slice(i + 1))
      assert.equal(overlaps(c, other), false);
  }
});

test("pathological density has a finite probe budget and never drops people", () => {
  const input = Array.from({ length: 2000 }, (_, i) =>
    card(String(i), 195, 300, 100 + i),
  );
  const result = placeSpatialCards(input, 390, 650);
  assert.equal(result.cards.length, input.length);
  assert.ok(result.probes <= input.length * SPATIAL_CARD_PROBES);
  assert.ok(result.probes <= input.length + SPATIAL_FRAME_PROBES);
  assert.ok(
    result.unresolved > 0,
    "a finite viewport cannot hold unlimited readable cards",
  );
  assert.ok(
    result.cards.every((c) => [c.x, c.y, c.size].every(Number.isFinite)),
  );
});

test("partially visible edge portraits still reserve their visible area", () => {
  const result = placeSpatialCards(
    [card("edge", -10, 150, 500), card("inside", 30, 150, 1000)],
    390,
    650,
  );
  assert.equal(
    result.cards[0].x,
    -10,
    "the offscreen anchor is not pulled into view",
  );
  assert.equal(overlaps(result.cards[0], result.cards[1]), false);
});
