import test from "node:test";
import assert from "node:assert/strict";
import {
  portraitCrop,
  portraitInitialFraming,
  portraitImageDelta,
} from "../src/domain/portrait-crop.ts";

test("the selected person's small face rectangle fits the circular portrait beyond the former 6x zoom", () => {
  const region = {
    id: "mark",
    personId: "selected",
    x: 0.65,
    y: 0.3,
    width: 0.05,
    height: 0.1,
  };
  const initial = portraitInitialFraming(1200, 800, region);
  assert.ok(initial.zoom > 6);
  assert.ok(initial.maxZoom > initial.zoom);
  const crop = portraitCrop(
    1200,
    800,
    initial.zoom,
    initial.center.x,
    initial.center.y,
    0,
    initial.maxZoom,
  );
  const cx = crop.x + crop.width / 2,
    cy = crop.y + crop.height / 2;
  assert.ok(Math.abs(cx - 810) < 1e-6);
  assert.ok(Math.abs(cy - 280) < 1e-6);
  for (const x of [region.x * 1200, (region.x + region.width) * 1200])
    for (const y of [region.y * 800, (region.y + region.height) * 800])
      assert.ok(Math.hypot(x - cx, y - cy) <= crop.width / 2 + 1e-6);
});

test("missing, corrupt and out-of-image marks retain the neutral whole-photo framing", () => {
  const fallback = portraitInitialFraming(1200, 800);
  for (const region of [
    { x: NaN, y: 0.5, width: 0.1, height: 0.1 },
    { x: 0.5, y: 0.5, width: 0, height: 0.1 },
    { x: 1.5, y: 0.5, width: 0.1, height: 0.1 },
  ])
    assert.deepEqual(portraitInitialFraming(1200, 800, region), fallback);
  const tiny = portraitInitialFraming(1200, 800, {
    x: 0.5,
    y: 0.5,
    width: Number.MIN_VALUE,
    height: Number.MIN_VALUE,
  });
  assert.ok(Number.isFinite(tiny.zoom) && Number.isFinite(tiny.maxZoom));
  assert.deepEqual(portraitCrop(1200, 800, 1, 0.5, 0.5), {
    x: 200,
    y: 0,
    width: 800,
    height: 800,
  });
});

test("rotated square corners stay inside landscape and portrait originals even while panning to edges", () => {
  for (const [width, height] of [
    [1200, 800],
    [800, 1200],
  ])
    for (const angle of [-180, -135, -90, -37, 0, 45, 90, 179])
      for (const zoom of [1, 1.2, 3, 15])
        for (const center of [-2, 0, 0.5, 1, 3]) {
          const crop = portraitCrop(
            width,
            height,
            zoom,
            center,
            center,
            angle,
            30,
          );
          const cx = crop.x + crop.width / 2,
            cy = crop.y + crop.height / 2;
          assert.equal(crop.width, crop.height);
          for (const dx of [-crop.width / 2, crop.width / 2])
            for (const dy of [-crop.width / 2, crop.width / 2]) {
              const p = portraitImageDelta(dx, dy, angle);
              assert.ok(cx + p.x >= -1e-6 && cx + p.x <= width + 1e-6);
              assert.ok(cy + p.y >= -1e-6 && cy + p.y <= height + 1e-6);
            }
        }
});

test("drag and keyboard directions use the inverse rotation of the original image", () => {
  const right = portraitImageDelta(25, 0, 90);
  assert.ok(Math.abs(right.x) < 1e-6);
  assert.equal(right.y, -25);
  const down = portraitImageDelta(0, 30, -90);
  assert.equal(down.x, -30);
  assert.ok(Math.abs(down.y) < 1e-6);
  for (const angle of [-180, -35, 0, 72, 180]) {
    const moved = portraitImageDelta(13, -27, angle);
    const restored = portraitImageDelta(moved.x, moved.y, -angle);
    assert.ok(Math.abs(restored.x - 13) < 1e-6);
    assert.ok(Math.abs(restored.y + 27) < 1e-6);
  }
});
