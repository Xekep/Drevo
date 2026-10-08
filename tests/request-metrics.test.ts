import test from "node:test";
import assert from "node:assert/strict";
import { requestMetrics } from "../src/server/request-metrics.ts";
test("request metrics are bounded and close each request once", () => {
  const metrics = requestMetrics();
  const first = metrics.begin(),
    second = metrics.begin(),
    third = metrics.begin();
  first(503, true);
  first(200, true);
  second(200, false);
  third(200, true);
  const result = metrics.snapshot();
  assert.equal(result.active, 0);
  assert.equal(result.completed, 3);
  assert.equal(result.serverErrors, 1);
  assert.equal(result.busy, 1);
  assert.equal(result.disconnected, 1);
  assert.equal(
    result.durationBuckets.reduce((sum, bucket) => sum + bucket.count, 0),
    3,
  );
});
