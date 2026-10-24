import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fixture } from "./postgres-fixture.ts";
import { readPostgresArchive } from "../../src/server/postgres-archive-read.ts";
import { readArchiveOverview } from "../../src/server/database.ts";
import { postgresBindings, type StoreDatabase } from "../../src/server/store-database.ts";
import { projectFamilyForUser, visiblePersonIds } from "../../src/domain/tree-access.ts";
import { archiveOverview } from "../../src/domain/archive-projection.ts";
import type { ArchiveUser } from "../../src/domain/access.ts";

test("PostgreSQL scoped overview filters JSON, relations and unions with native RLS", async t => {
  const { first } = await fixture(t);
  const runtimeSql = readFileSync(new URL("../../ops/postgres/010_runtime_services.sql", import.meta.url), "utf8");
  // The focused fixture omits migration 010. Use its real policies for these
  // tables, including FORCE RLS, before switching to the non-bypass reader.
  for (const table of ["people", "relations", "photos", "archives"]) {
    const policy = runtimeSql.match(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;[\\s\\S]*?CREATE POLICY archive_scope ON ${table}[^;]+;`))?.[0];
    assert.ok(policy);
    await first.query(policy);
  }
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await first.query(`INSERT INTO family_unions(archive_id,id,ordinal,participant_a,participant_b,data)
    VALUES('tree-a','visible',0,'father','child','{"id":"visible","participants":["father","child"],"type":"partnership"}'),
          ('tree-a','hidden',1,'father','own','{"id":"hidden","participants":["father","own"],"type":"partnership"}')`);
  // An own card stays visible even when its parent is private; parent evidence
  // and unrelated links must not reveal that private parent in the overview.
  await first.query(`INSERT INTO people(archive_id,id,ordinal,data)
    VALUES('tree-a','private',3,'{"id":"private","name":"Private","surname":"Test","sources":[]}')`);
  await first.query(`INSERT INTO people(archive_id,id,ordinal,data)
    SELECT 'tree-a','private-'||i,4+i,jsonb_build_object('id','private-'||i,'name','Private','biography',repeat('x',200),'sources','[]'::jsonb)
    FROM generate_series(1,1000) i`);
  await first.query(`INSERT INTO relations(archive_id,id,ordinal,source,target,type,confidence)
    VALUES('tree-a','private-parent',2,'private','own','parent','confirmed')`);
  const user: ArchiveUser = { id: "relative", name: "Reader", role: "reader", approved: true,
    createdAt: "2026-01-01", personId: "child", treeAccess: "common_ancestors" };
  const full = (await readPostgresArchive(first, "tree-a")).family;
  const visible = visiblePersonIds(full, user);
  assert.ok(!visible.has("private"));
  const expected = archiveOverview(projectFamilyForUser(full, user));
  // An absent optional list and an empty list both mean no exposed evidence;
  // SQL need not read a private claim merely to preserve an empty JSON key.
  for (const p of expected.people) if (!p.parentClaims?.length) delete p.parentClaims;
  const db = { prepare: (_sqlite: string, postgres: string) => {
    const sql = postgresBindings(postgres);
    const rows = async (...values: unknown[]) => (await first.query(sql, values)).rows.map(row =>
      row.data && typeof row.data === "object" ? { ...row, data: JSON.stringify(row.data) } : row);
    return { all: rows, get: async (...values: unknown[]) => (await rows(...values))[0] };
  } } as unknown as StoreDatabase;
  const role = `scope_${randomUUID().replaceAll("-", "")}`;
  const schema = String((await first.query("SELECT current_schema() AS name")).rows[0].name);
  await first.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  try {
    await first.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
    await first.query(`GRANT SELECT ON archives,people,relations,family_unions,photos TO ${role}`);
    await first.query(`SET ROLE ${role}`);
    const result = await readArchiveOverview(db, true, visible);
    assert.deepEqual(JSON.parse(JSON.stringify(archiveOverview(result.family))), JSON.parse(JSON.stringify(expected)));
    assert.equal(result.family.people.length, visible.size);
    assert.ok(!JSON.stringify(result.family).includes("private"));
    const none = await readArchiveOverview(db, true, new Set());
    assert.deepEqual(none.family.people, []);
    assert.deepEqual(none.family.links, []);
    await first.query("SELECT set_config('drevo.archive_id','tree-b',false)");
    const other = await readArchiveOverview(db, true, visible);
    assert.ok(!other.family.unions?.some(union => union.id === "visible"));
    assert.ok(other.family.people.every(p => !p.parentClaims?.length));
  } finally {
    await first.query("RESET ROLE");
    await first.query(`DROP OWNED BY ${role}`);
    await first.query(`DROP ROLE ${role}`);
  }
});
