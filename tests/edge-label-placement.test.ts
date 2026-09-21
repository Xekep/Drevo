import test from "node:test";
import assert from "node:assert/strict";
import { edgeLabelPlacement } from "../src/components/tree/edge-label-placement.ts";

const fallback = {
  x: 50,
  y: 50,
  source: { x: 0, y: 0 },
  target: { x: 100, y: 100 },
};

test("label follows the longest horizontal segment in route direction", () => {
  assert.deepEqual(
    edgeLabelPlacement(
      [{ x: 300, y: 10 }, { x: 100, y: 10 }, { x: 100, y: 80 }],
      fallback,
    ),
    { x: 200, y: 10, vertical: false, reversed: true, length: 200 },
  );
});

test("vertical label follows an upward segment and stays on the line", () => {
  assert.deepEqual(
    edgeLabelPlacement(
      [{ x: 80, y: 300 }, { x: 80, y: 90 }, { x: 120, y: 90 }],
      fallback,
    ),
    { x: 80, y: 195, vertical: true, reversed: true, length: 210 },
  );
});

test("unrouted edge uses its path anchor and endpoint direction", () => {
  assert.deepEqual(edgeLabelPlacement(undefined, fallback), {
    x: 50,
    y: 50,
    vertical: false,
    reversed: false,
    length: 100,
  });
});