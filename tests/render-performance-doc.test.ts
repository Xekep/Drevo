import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("render performance documentation records the intended invariants", () => {
  const text = readFileSync("docs/render-performance.md", "utf8");
  assert.match(text, /пересеч/i);
  assert.match(text, /requestId/);
  assert.match(text, /PersonNode/);
  assert.match(text, /RelationshipEdge/);
});
