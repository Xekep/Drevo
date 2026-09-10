import test from "node:test";
import assert from "node:assert/strict";
import { isSecondTap, zoomAt } from "../src/components/tree/touch-zoom.ts";

test("two nearby taps form a double tap; distant or delayed taps do not", () => {
  const first = { x: 100, y: 200, time: 1000 };
  assert.ok(isSecondTap(first, { x: 108, y: 205, time: 1210 }));
  assert.equal(isSecondTap(first, { x: 140, y: 200, time: 1210 }), false);
  assert.equal(isSecondTap(first, { x: 100, y: 200, time: 1400 }), false);
  assert.equal(isSecondTap(null, first), false);
});
test("one-finger zoom keeps the touched family in place at both zoom limits", () => {
  const initial = { x: -400, y: -800, zoom: 0.5 },
    anchor = { x: 170, y: 310 };
  const world = {
    x: (anchor.x - initial.x) / initial.zoom,
    y: (anchor.y - initial.y) / initial.zoom,
  };
  for (const factor of [1.6, 0.5, 100, 0.0001]) {
    const next = zoomAt(initial, anchor, factor);
    assert.ok(next.zoom >= 0.05 && next.zoom <= 1.8);
    assert.ok(Math.abs(next.x + world.x * next.zoom - anchor.x) < 0.000001);
    assert.ok(Math.abs(next.y + world.y * next.zoom - anchor.y) < 0.000001);
  }
  assert.equal(zoomAt(initial, anchor, 100).zoom, 1.8);
  assert.equal(zoomAt(initial, anchor, 0.0001).zoom, 0.05);
  assert.deepEqual(initial, { x: -400, y: -800, zoom: 0.5 });
});
