import test from "node:test";
import assert from "node:assert/strict";
import { SpatialSpinGesture } from "../src/components/tree/spatial-spin-gesture.ts";

const point = (x: number, time: number, y = 0) => ({ x, y, time });

for (const direction of [-1, 1])
  test(`a deliberate fast horizontal stroke starts direction ${direction}`, () => {
    const gesture = new SpatialSpinGesture();
    gesture.begin(1, point(0, 0), 600, true);
    for (let i = 1; i <= 4; i++)
      gesture.move(1, point(direction * i * 60, i * 30));
    assert.equal(gesture.end(1, point(direction * 240, 130)), direction);
    assert.equal(
      gesture.end(1, point(direction * 240, 140)),
      0,
      "a stroke only fires once",
    );
  });

test("small, slow, vertical and paused drags remain ordinary camera gestures", () => {
  for (const [dx, dy, period, hold] of [
    [60, 0, 30, 0],
    [240, 0, 150, 0],
    [240, 300, 30, 0],
    [240, 0, 30, 300],
  ]) {
    const gesture = new SpatialSpinGesture();
    gesture.begin(1, point(0, 0), 600, true);
    for (let i = 1; i <= 4; i++)
      gesture.move(1, point((dx * i) / 4, i * period, (dy * i) / 4));
    assert.equal(gesture.end(1, point(dx, 4 * period + hold, dy)), 0);
  }
});

test("pan/modifier gestures cannot arm rotation", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 600, false);
  gesture.move(1, point(240, 100));
  assert.equal(gesture.end(1, point(240, 110)), 0);
});

test("a second touch cancels the command until every finger has lifted", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 600, true);
  gesture.move(1, point(100, 40));
  gesture.begin(2, point(20, 50), 600, true);
  assert.equal(gesture.end(1, point(300, 120)), 0);
  assert.equal(gesture.end(2, point(320, 130)), 0);
  gesture.begin(3, point(0, 200), 600, true);
  gesture.move(3, point(-240, 300));
  assert.equal(gesture.end(3, point(-240, 310)), -1);
});

test("cancellation, a reversed stroke and invalid samples do not retain an old direction", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 600, true);
  gesture.move(1, point(240, 100));
  gesture.cancel(1);
  assert.equal(gesture.end(1, point(240, 110)), 0);
  gesture.begin(1, point(0, 200), 600, true);
  gesture.move(1, point(-300, 240));
  gesture.move(1, point(160, 310));
  assert.equal(gesture.end(1, point(160, 320)), 1);
  gesture.begin(1, point(0, 400), 600, true);
  gesture.move(1, point(NaN, 500));
  assert.equal(gesture.end(1, point(240, 510)), 0);
  gesture.begin(1, point(0, 600), 0, true);
  assert.equal(gesture.end(1, point(240, 700)), 0);
});

test("a long drag only considers its final recent stroke, with bounded samples", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 600, true);
  for (let i = 1; i <= 1000; i++) gesture.move(1, point(i / 10, i));
  gesture.move(1, point(160, 1030));
  gesture.move(1, point(220, 1060));
  gesture.move(1, point(280, 1090));
  gesture.move(1, point(340, 1120));
  assert.equal(gesture.end(1, point(340, 1130)), 1);
});

test("sparse native events interpolate the window boundary rather than discarding a fast segment", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 654, true);
  gesture.move(1, point(60, 120));
  gesture.move(1, point(120, 180));
  gesture.move(1, point(180, 245));
  gesture.move(1, point(240, 310));
  assert.equal(gesture.end(1, point(240, 320)), 1);
});

test("a strong stroke tolerates natural deceleration and a short release pause", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 600, true);
  gesture.move(1, point(120, 80));
  gesture.move(1, point(138, 150));
  gesture.move(1, point(140, 210));
  assert.equal(gesture.end(1, point(140, 260)), 1);
});

test("a latched command expires when the hand rests instead of releasing", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 600, true);
  gesture.move(1, point(120, 80));
  assert.equal(gesture.end(1, point(120, 310)), 0);
});

test("high-resolution screens do not require an excessively long stroke", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 1600, true);
  gesture.move(1, point(-190, 100));
  assert.equal(gesture.end(1, point(-190, 160)), -1);
});

test("a fast stroke sampled in one display frame still commands rotation", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 600, true);
  gesture.move(1, point(100, 20));
  assert.equal(gesture.end(1, point(100, 40)), 1);
});

test("an intentional counter-stroke cancels an armed direction", () => {
  const gesture = new SpatialSpinGesture();
  gesture.begin(1, point(0, 0), 600, true);
  gesture.move(1, point(200, 100));
  gesture.move(1, point(170, 120));
  assert.equal(gesture.end(1, point(170, 130)), 0);
});
