import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./postgres-fixture.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { persistPostgresGraphChanges } from "../../src/server/postgres-graph-rows.ts";
import { patchPostgresPeopleForSession } from "../../src/server/postgres-person-patches.ts";
import { change, tokens } from "./postgres-fixture.ts";

test("two PostgreSQL cold starters serialize migration 088 after the old 078 CHECK", async (t) => {
  const { first, second, third } = await fixture(t);
  await first.query(`DROP TRIGGER protect_parent_evidence_before_write ON relations;
    DROP FUNCTION protect_parent_evidence_write();
    ALTER TABLE relations DROP CONSTRAINT relations_parent_confidence_check;
    ALTER TABLE relations ADD CONSTRAINT relations_check2 CHECK
      (confidence IS NULL OR (type NOT IN ('parent','spouse') AND confidence IN
        ('confirmed','probable','tentative','conflicting','unknown')))`);
  const ready = `SELECT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='relations'::regclass
    AND conname='relations_parent_confidence_check') AND
    EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='relations'::regclass
      AND tgname='protect_parent_evidence_before_write') AS present`;
  assert.equal((await first.query(ready)).rows[0].present, false);
  assert.equal((await second.query(ready)).rows[0].present, false);
  const migration = readFileSync(new URL("../../ops/postgres/088_parent_confidence.sql", import.meta.url), "utf8");
  await first.query("BEGIN");
  await second.query("BEGIN");
  try {
    await first.query("SELECT pg_advisory_xact_lock(186743291)");
    const secondPid = (await second.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const blocked = second.query("SELECT pg_advisory_xact_lock(186743291)");
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      waiting = (await third.query(`SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity
        WHERE pid=$1`, [secondPid])).rows[0]?.waiting ?? false;
      if (waiting) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, true, "second starter reaches the advisory lock before first commits");
    if (!(await first.query(ready)).rows[0].present) await first.query(migration);
    await first.query("COMMIT");
    await blocked;
    assert.equal((await second.query(ready)).rows[0].present, true,
      "the second READ COMMITTED starter sees committed DDL and skips migration");
    await second.query("COMMIT");
  } finally {
    await Promise.all([first.query("ROLLBACK").catch(() => {}), second.query("ROLLBACK").catch(() => {})]);
  }
});

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

test("PostgreSQL stores parent evidence on one existing edge without creating another relation", async (t) => {
  const { first } = await fixture(t);
  const before = (await readPostgresArchive(first, "tree-a")).family;
  const next = structuredClone(before);
  next.people.find((person) => person.id === "child")!.parentClaims = [{ parentId: "father",
    sources: [{ title: "Birth register", type: "book", reference: "p. 4" }],
    confidence: "probable" }];
  await first.query("BEGIN");
  try {
    await persistPostgresGraphChanges(first, "tree-a", before, next);
    await first.query("COMMIT");
  } catch (error) { await first.query("ROLLBACK"); throw error; }
  const row = await first.query("SELECT id,sources,confidence FROM relations WHERE archive_id='tree-a' AND type='parent'");
  assert.equal(row.rowCount, 1);
  assert.equal(row.rows[0].id, "parent:father:child");
  assert.equal(row.rows[0].confidence, "probable");
  assert.equal(row.rows[0].sources[0].reference, "p. 4");
  await assert.rejects(first.query("UPDATE relations SET sources='[]'::jsonb,confidence=NULL WHERE archive_id='tree-a' AND id='parent:father:child'"),
    /Unsupported writer for parent evidence/);
  await assert.rejects(first.query("DELETE FROM relations WHERE archive_id='tree-a' AND id='parent:father:child'"),
    /Unsupported writer for parent evidence/);
  await first.query("UPDATE relations SET note='safe old writer change' WHERE archive_id='tree-a' AND id='parent:father:child'");
  await assert.rejects(first.query("UPDATE relations SET source='own' WHERE archive_id='tree-a' AND id='parent:father:child'"),
    /Unsupported writer for parent evidence/);
  await assert.rejects(first.query("UPDATE relations SET archive_id='tree-b' WHERE archive_id='tree-a' AND id='parent:father:child'"),
    /Unsupported writer for parent evidence/);
  await first.query("BEGIN");
  try {
    await assert.rejects(first.query("DELETE FROM archives WHERE id='tree-a'"),
      /Unsupported writer for parent evidence/);
  } finally { await first.query("ROLLBACK"); }
  await first.query("BEGIN");
  try {
    await first.query("SELECT set_config('drevo.parent_evidence_write','on',true)");
    await first.query("UPDATE relations SET ordinal=ordinal WHERE archive_id='tree-a' AND id='parent:father:child'");
    await first.query("COMMIT");
  } catch (error) { await first.query("ROLLBACK"); throw error; }
  assert.equal((await readPostgresArchive(first, "tree-a")).family.people
    .find((person) => person.id === "child")?.parentClaims?.[0].confidence, "probable");
  assert.equal((await readPostgresArchive(first, "tree-b")).family.people
    .find((person) => person.id === "child")?.parentClaims, undefined);
  await patchPostgresPeopleForSession(first, tokens.admin, "tree-a",
    change("surname", "Тест", "Changed", "child"), 0);
  assert.equal((await readPostgresArchive(first, "tree-a")).family.people
    .find((person) => person.id === "child")?.parentClaims?.[0].confidence, "probable",
  "the PostgreSQL card-only fast path retains relation evidence");
});
