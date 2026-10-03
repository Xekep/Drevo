import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./postgres-fixture.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { persistPostgresGraphChanges } from "../../src/server/postgres-graph-rows.ts";

test("PostgreSQL persists additional-relation confidence without crossing archives", async (t) => {
  const { first } = await fixture(t);
  const before = (await readPostgresArchive(first, "tree-a")).family;
  const next = structuredClone(before);
  next.links = [{ id: "care-assessment", from: "father", to: "own",
    type: "guardian", confidence: "probable" }];
  await first.query("BEGIN");
  try {
    await persistPostgresGraphChanges(first, "tree-a", before, next);
    await first.query("COMMIT");
  } catch (error) { await first.query("ROLLBACK"); throw error; }
  assert.equal((await readPostgresArchive(first, "tree-a")).family.links?.[0].confidence,
    "probable");
  assert.equal((await readPostgresArchive(first, "tree-b")).family.links?.length, 0);
});
