import { test } from "node:test";
import assert from "node:assert/strict";
import { gpuRoute } from "../src/components/tree/gpu-route.ts";

test("GPU routes preserve crossing gaps and restart dash phase after M", () => {
  const result = gpuRoute("M 0 0 L 20 0 M 25 0 L 40 0");
  assert.deepEqual(result, [
    { ax: 0, ay: 0, bx: 20, by: 0, distance: 0 },
    { ax: 25, ay: 0, bx: 40, by: 0, distance: 0 },
  ]);
});
test("GPU rounded routes reach their exact endpoint and keep dash distance continuous", () => {
  const result = gpuRoute("M 10 20 L 30 20 Q 40 20 40 30 L 40 50");
  assert.equal(result.length, 10);
  assert.equal(result.at(-1)!.bx, 40);
  assert.equal(result.at(-1)!.by, 50);
  for (let i = 1; i < result.length; i++) {
    assert.equal(result[i].ax, result[i - 1].bx);
    assert.equal(result[i].ay, result[i - 1].by);
    assert.ok(result[i].distance > result[i - 1].distance);
  }
});
test("unsupported and invalid GPU geometry fails instead of silently losing relationships", () => {
  assert.throws(() => gpuRoute("M 0 0 C 10 0 10 10 20 10"));
  assert.throws(() => gpuRoute("M 0 0 L NaN 4"));
});
