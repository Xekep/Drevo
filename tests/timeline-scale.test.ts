import test from "node:test";
import assert from "node:assert/strict";
import {
  timelineCenturies,
  timelineScale,
} from "../src/domain/timeline-scale.ts";
import { yearY } from "../src/domain/layout.ts";

test("a timeline starting in 1830 keeps the partial nineteenth century", () => {
  const centuries = timelineCenturies(1830);
  assert.deepEqual(
    centuries.map((c) => c.label),
    ["XIX", "XX", "XXI"],
  );
  assert.equal(centuries[0].from, 1830);
  assert.equal(centuries[0].to, 1901);
  assert.equal(timelineCenturies(1900)[0].label, "XIX");
  assert.equal(timelineCenturies(1901)[0].label, "XX");
});

test("centuries and eras follow the same projection as people in either time direction", () => {
  for (const reverse of [false, true]) {
    const geometry = { start: 1830, offset: 520, reverse };
    for (const zoom of [0.15, 0.5, 1, 1.8]) {
      const viewport = { y: -350, zoom };
      const scale = timelineScale(geometry, viewport, 800);
      assert.equal(
        scale.project(1922),
        viewport.y +
          (geometry.offset + yearY(1922, geometry.start, reverse)) * zoom,
      );
      const soviet = scale.eras.find((era) => era.className === "soviet")!;
      assert.equal(
        soviet.top,
        Math.min(scale.project(1922), scale.project(1991)),
      );
      assert.equal(
        soviet.bottom,
        Math.max(scale.project(1922), scale.project(1991)),
      );
      assert.ok(soviet.height > 0);
      assert.equal(scale.undatedEnd, viewport.y + geometry.offset * zoom);
    }
  }
});

test("century captions stay visible inside a period after its start scrolls off screen", () => {
  const geometry = { start: 1830, offset: 0, reverse: false };
  const scale = timelineScale(geometry, { y: -yearY(1940), zoom: 1 }, 550);
  const century = scale.centuries.find((c) => c.label === "XX")!;
  assert.ok(century.top < 0);
  assert.equal(century.visibleTop, 66);
  assert.ok(century.visibleHeight >= 66);
  assert.equal(
    scale.eras.find((e) => e.className === "soviet")!.visibleTop,
    66,
  );
});

test("decade marks are restricted to the viewport and thin out at low zoom", () => {
  const geometry = { start: 1, offset: 700, reverse: false };
  for (const zoom of [0.15, 0.5, 1, 1.8]) {
    const scale = timelineScale(
      geometry,
      { y: -(700 + yearY(1700, 1)) * zoom, zoom },
      720,
    );
    assert.ok(scale.ticks.length <= 15);
    assert.ok(
      scale.ticks.every((tick) => tick.y >= -0.001 && tick.y <= 720.001),
    );
    for (let i = 1; i < scale.ticks.length; i++)
      assert.ok(scale.ticks[i].y - scale.ticks[i - 1].y >= 52 - 0.001);
  }
  assert.equal(
    timelineScale(geometry, { y: 5000, zoom: 1 }, 720).ticks.length,
    0,
  );
});
