import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fixture } from "./postgres-fixture.ts";
import { discoveryNamePartsBatch } from "../../ops/postgres/backfill-discovery-name-parts.ts";
import { discoveryArchiveAliasPredicate } from "../../src/server/discovery-archive-id.ts";

test("legacy route index resolves aliases without replacing the keyset backfill index", async t => {
  const { first } = await fixture(t);
  await first.query(`CREATE TABLE discovery_people (
    archive_id text NOT NULL, person_id text NOT NULL, name text NOT NULL,
    surname_part text, given_part text, PRIMARY KEY(archive_id,person_id));
    CREATE TABLE published_people (archive_id text NOT NULL, person_id text NOT NULL,
      PRIMARY KEY(archive_id,person_id))`);
  await first.query(readFileSync(new URL("../../ops/postgres/112_discovery_person_lookup.sql", import.meta.url), "utf8"));
  await first.query(`INSERT INTO people(archive_id,id,ordinal,data)
    SELECT 'tree-a','load-'||g,1000+g,
      jsonb_build_object('id','load-'||g,'surname','Нагрузов','name','Даниил','deceased',true)
    FROM generate_series(1,600) g`);
  await first.query(`INSERT INTO published_people SELECT 'tree-a','load-'||g FROM generate_series(1,600) g;
    INSERT INTO discovery_people(archive_id,person_id,name)
      SELECT archive_id,person_id,'Нагрузов Даниил' FROM published_people`);
  await first.query("BEGIN");
  try {
    await first.query("SET LOCAL enable_seqscan=off");
    const aliasPlan = await first.query(`EXPLAIN (FORMAT JSON)
      SELECT archive_id FROM discovery_people WHERE person_id=$1 AND ${discoveryArchiveAliasPredicate}`, ["load-250"]);
    assert.match(JSON.stringify(aliasPlan.rows), /discovery_people_person_lookup/);
    const backfillPlan = await first.query(`EXPLAIN (FORMAT JSON) ${discoveryNamePartsBatch}`, ["tree-a", "load-200"]);
    assert.match(JSON.stringify(backfillPlan.rows), /discovery_people_pkey/);
    assert.doesNotMatch(JSON.stringify(backfillPlan.rows), /discovery_people_person_lookup/);
    const batch = (await first.query(discoveryNamePartsBatch, ["tree-a", "load-200"])).rows[0];
    assert.equal(batch.changed, 100);
    assert.ok(batch.last_person_id > "load-200");
    assert.equal((await first.query("SELECT surname_part FROM discovery_people WHERE person_id='load-100'")).rows[0].surname_part, null,
      "rows before the cursor are not rewritten");
    const upper = "ABCDEF00-0000-0000-0000-000000000001", lower = upper.toLowerCase();
    await first.query(`INSERT INTO discovery_people(archive_id,person_id,name)
      VALUES($1,'same','A'),($2,'same','B')`, [upper, lower]);
    assert.deepEqual((await first.query(`SELECT archive_id FROM discovery_people
      WHERE person_id='same' AND ${discoveryArchiveAliasPredicate}`)).rows.map(row => row.archive_id), [upper]);
    assert.equal((await first.query("SELECT archive_id FROM discovery_people WHERE archive_id=$1 AND person_id='same'", [lower])).rowCount, 1);
  } finally { await first.query("ROLLBACK"); }
});
