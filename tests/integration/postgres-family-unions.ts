import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./postgres-fixture.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { persistPostgresGraphChanges } from "../../src/server/postgres-graph-rows.ts";
import type { FamilyUnion } from "../../src/domain/types.ts";

test("PostgreSQL persists distinct unions with tenant isolation and removal", async (t) => {
  const { first } = await fixture(t);
  const before = (await readPostgresArchive(first, "tree-a")).family;
  const unions: FamilyUnion[] = [
    { id: "first", participants: ["father", "own"], type: "marriage", formation: { dateText: "около 1970 года" }, divorce: { date: "1980" } },
    { id: "second", participants: ["father", "own"], type: "partnership", formation: { date: "1990" }, note: "Вторая запись" },
  ];
  await first.query("BEGIN");
  try {
    await persistPostgresGraphChanges(first, "tree-a", before, { ...before, unions });
    await first.query("COMMIT");
  } catch (error) { await first.query("ROLLBACK"); throw error; }
  assert.deepEqual((await readPostgresArchive(first, "tree-a")).family.unions, unions);
  assert.equal((await readPostgresArchive(first, "tree-b")).family.unions, undefined);
  await first.query("BEGIN");
  try {
    await persistPostgresGraphChanges(first, "tree-a", { ...before, unions }, before);
    await first.query("COMMIT");
  } catch (error) { await first.query("ROLLBACK"); throw error; }
  assert.equal((await readPostgresArchive(first, "tree-a")).family.unions, undefined);
});
