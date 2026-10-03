import assert from "node:assert/strict";
import test from "node:test";
import { timelineRowWindow } from "../src/domain/timeline-window.ts";

test("3313 fixed CSS rows mount only a small desktop or mobile window", () => {
  assert.deepEqual(timelineRowWindow(3313, 0, 640, 64), {
    start: 0,
    end: 13,
    before: 0,
    after: 3300 * 64,
  });
  assert.deepEqual(timelineRowWindow(3313, 0, 360, 62), {
    start: 0,
    end: 9,
    before: 0,
    after: 3304 * 62,
  });
  for (const [height, rowHeight] of [
    [640, 64],
    [360, 62],
  ]) {
    for (const index of [0, 25, 1000, 3300]) {
      const window = timelineRowWindow(
        3313,
        86 + index * rowHeight,
        height,
        rowHeight,
      );
      assert.ok(window.start <= index && window.end > index);
      assert.ok(window.end - window.start <= Math.ceil(height / rowHeight) + 8);
      assert.equal(
        window.before + (window.end - window.start) * rowHeight + window.after,
        3313 * rowHeight,
        "virtualization preserves the full scrollable row height",
      );
    }
  }
});

test("row edges and zero overscan preserve partial rows and exclusive endpoints", () => {
  assert.deepEqual(timelineRowWindow(10, 86, 64, 64, 0), {
    start: 0,
    end: 1,
    before: 0,
    after: 576,
  });
  assert.deepEqual(timelineRowWindow(10, 150, 64, 64, 0), {
    start: 1,
    end: 2,
    before: 64,
    after: 512,
  });
  assert.deepEqual(timelineRowWindow(10, 150.5, 64, 64, 0), {
    start: 1,
    end: 3,
    before: 64,
    after: 448,
  });
  assert.deepEqual(timelineRowWindow(10, -40, 86, 64, 0), {
    start: 0,
    end: 0,
    before: 0,
    after: 640,
  });
  assert.deepEqual(timelineRowWindow(10, 0, 62, 62, 0, 0), {
    start: 0,
    end: 1,
    before: 0,
    after: 558,
  });
});

test("empty and shortened lists remain valid even with a stale deep scroll position", () => {
  assert.deepEqual(timelineRowWindow(0, 250000, 360, 62), {
    start: 0,
    end: 0,
    before: 0,
    after: 0,
  });
  assert.deepEqual(timelineRowWindow(3, 250000, 360, 62), {
    start: 3,
    end: 3,
    before: 186,
    after: 0,
  });
  assert.deepEqual(timelineRowWindow(3, 86 + 3 * 62, 360, 62, 0), {
    start: 3,
    end: 3,
    before: 186,
    after: 0,
  });
  assert.deepEqual(timelineRowWindow(3, 0, 640, 64), {
    start: 0,
    end: 3,
    before: 0,
    after: 0,
  });
});

test("large scroll jumps and resized viewports recalculate from current CSS row height", () => {
  assert.deepEqual(timelineRowWindow(5000, 64086, 128, 64), {
    start: 996,
    end: 1006,
    before: 996 * 64,
    after: 3994 * 64,
  });
  assert.deepEqual(timelineRowWindow(5000, 62086, 124, 62), {
    start: 996,
    end: 1006,
    before: 996 * 62,
    after: 3994 * 62,
  });
  const small = timelineRowWindow(5000, 64086, 128, 64);
  const large = timelineRowWindow(5000, 64086, 640, 64);
  assert.equal(large.start, small.start);
  assert.equal(large.end - small.end, 8);
  assert.throws(() => timelineRowWindow(1, 0, 640, 0), RangeError);
});
