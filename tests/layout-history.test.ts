import test from "node:test";
import assert from "node:assert/strict";
import { layoutCacheKey } from "../src/components/tree/layout-cache.ts";
import { compatibleLayoutHistory } from "../src/components/tree/layout-history.ts";

test("persistent history accepts small graph edits and rejects incompatible projections", () => {
  const people = Array.from({ length: 210 }, (_, i) => ({ id: String(i), birth: "", parents: [], spouses: [] }));
  const input = { people, links: [], mode: "generations" as const, reverse: false };
  const old = layoutCacheKey(input);
  const next = layoutCacheKey({ ...input, people: [...people, { id: "child", birth: "", parents: ["1"], spouses: [] }] });
  assert.deepEqual(compatibleLayoutHistory(next, old), input);
  assert.equal(compatibleLayoutHistory(layoutCacheKey({ ...input, people: people.slice(5) }), old), undefined);
  assert.equal(compatibleLayoutHistory(layoutCacheKey({ ...input, reverse: true }), old), undefined);
  assert.equal(compatibleLayoutHistory(layoutCacheKey({ ...input, mode: "timeline" }), old), undefined);
  const legacy = JSON.parse(old); legacy.version--;
  assert.equal(compatibleLayoutHistory(next, JSON.stringify(legacy)), undefined);
  assert.equal(compatibleLayoutHistory(next, "broken"), undefined);
});
