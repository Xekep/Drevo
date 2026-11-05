import test from "node:test";
import assert from "node:assert/strict";
import { createGpuMotion } from "../src/components/tree/gpu-motion.ts";

test("GPU cards fly from their previous positions while only new cards fade in", () => {
  const motion = createGpuMotion([
    { id: "retained", position: { x: 500, y: 200 } },
    { id: "new", position: { x: 700, y: 200 } },
  ]);
  motion.transition(new Map([["retained", { x: 100, y: 0 }]]), false);
  assert.deepEqual([...motion.data.slice(4, 8)], [-400, -200, 1, 1]);
  assert.deepEqual([...motion.data.slice(8, 12)], [0, 0, 0, 1]);
  assert.deepEqual(motion.positions().get("retained"), {
    x: 100,
    y: 0,
    opacity: 1,
  });
  motion.progress(0.5);
  assert.deepEqual(motion.positions().get("retained"), {
    x: 300,
    y: 100,
    opacity: 1,
  });
  motion.progress(1);
  assert.deepEqual(motion.positions().get("retained"), {
    x: 500,
    y: 200,
    opacity: 1,
  });
});

test("interrupted GPU flights start at the displayed position and departing cards stay still", () => {
  const old = createGpuMotion([
    { id: "retained", position: { x: 500, y: 200 } },
    { id: "removed", position: { x: 700, y: 200 } },
  ]);
  old.transition(
    new Map([
      ["retained", { x: 100, y: 0 }],
      ["removed", { x: 900, y: 200 }],
    ]),
    false,
  );
  old.progress(0.5);
  const next = createGpuMotion([
    { id: "retained", position: { x: -100, y: -100 } },
  ]);
  next.transition(old.positions(), false);
  old.transition(next.positions(), true);
  assert.deepEqual(next.positions().get("retained"), {
    x: 300,
    y: 100,
    opacity: 1,
  });
  assert.deepEqual(
    [...old.data.slice(6, 8)],
    [0, 0],
    "common cards cannot be drawn twice",
  );
  old.progress(0.8);
  assert.deepEqual(old.positions().get("removed"), {
    x: 800,
    y: 200,
    opacity: 1 - 0.8,
  });
  assert.deepEqual([...old.data.slice(10, 12)], [1, 0]);
});

test("motion texture stays bounded and every glyph of an item uses the same index", () => {
  const items = Array.from({ length: 6000 }, (_, i) => ({
    id: String(i),
    position: { x: i, y: 0 },
  }));
  const motion = createGpuMotion(items);
  assert.equal(motion.index("missing"), 0);
  assert.equal(motion.index("5999"), 6000);
  assert.ok(motion.data.byteLength <= 100_000);
  assert.deepEqual([...motion.data.slice(0, 4)], [0, 0, 1, 1]);
});

test("interrupting a fade preserves the current opacity instead of flashing an opaque card", () => {
  const items = [{ id: "added", position: { x: 100, y: 0 } }];
  const old = createGpuMotion(items);
  old.transition(new Map(), false);
  old.progress(0.25);
  const next = createGpuMotion(items);
  next.transition(old.positions(), false);
  assert.equal(next.data[6], 0.25);
  old.transition(new Map(), true);
  assert.equal(old.data[6], 0.25);
  old.progress(0.5);
  assert.equal(old.positions().get("added")!.opacity, 0.125);
});


test("manual GPU translations stay aligned and a subsequent fold starts at the displayed position", () => {
  const motion = createGpuMotion([{ id: "card", position: { x: 100, y: 200 } }]);
  motion.relocate(new Map([["card", { x: 140, y: 200 }]]));
  motion.progress(1);
  assert.deepEqual(motion.positions().get("card"), { x: 140, y: 200, opacity: 1 });
  motion.relocate(new Map([["card", { x: 80, y: 200 }]]));
  const next = createGpuMotion([{ id: "card", position: { x: 300, y: 200 } }]);
  next.transition(motion.positions(), false);
  assert.deepEqual(next.positions().get("card"), { x: 80, y: 200, opacity: 1 });
  motion.relocate(new Map([["card", { x: 100, y: 200 }]]));
  assert.deepEqual(motion.positions().get("card"), { x: 100, y: 200, opacity: 1 });
});
