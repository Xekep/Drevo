import assert from "node:assert/strict";
import type pg from "pg";
import { mediaReferenceAccess } from "../../src/server/media-reference-access.ts";
import {
  postgresBindings,
  type StoreDatabase,
} from "../../src/server/store-database.ts";
import type { openArchive } from "../../src/server/database.ts";

/** Actual production SELECT plus equivalent candidates, only on synthetic data. */
export async function benchmarkMediaReferencePlans(
  client: pg.Client,
  archiveId: string,
  photoUrl: string,
) {
  assert.match(
    process.env.PGDATABASE || "",
    /^drevo_migration_bench_[a-z0-9_]+$/,
  );
  const captured: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    kind: "postgres",
    prepare(_sqlite: string, sql: string) {
      return {
        get: async (...values: unknown[]) => {
          captured.push({ sql: postgresBindings(sql), values });
          // Capturing the query does not issue an authorization grant or an HTTP
          // response. The actual SELECT is executed below by EXPLAIN ANALYZE.
          return { captured: true };
        },
      };
    },
  } as unknown as StoreDatabase;
  await mediaReferenceAccess({ db } as Awaited<ReturnType<typeof openArchive>>)(
    photoUrl,
    {
      id: "owner",
      name: "Synthetic owner",
      role: "admin",
      approved: true,
      createdAt: "2026-10-12",
      treeAccess: "all",
    },
  );
  assert.equal(
    captured.length,
    1,
    "The gallery URL must capture its direct reference SELECT",
  );
  const { sql, values } = captured[0];
  const start = "SELECT 1 FROM request q WHERE ";
  const separator = "\n       OR ";
  const predicateStart = sql.indexOf(start) + start.length;
  const split = sql.indexOf(separator, predicateStart);
  assert.ok(predicateStart >= start.length && split > predicateStart);
  const photoFirst =
    sql.slice(0, predicateStart) +
    sql.slice(split + separator.length) +
    separator +
    sql.slice(predicateStart, split);
  const explicitArchive = (query: string) =>
    query
      .replace(
        "FROM people p WHERE ",
        "FROM people p WHERE p.archive_id=current_setting('drevo.archive_id',true) AND ",
      )
      .replace(
        "FROM photos p WHERE ",
        "FROM photos p WHERE p.archive_id=current_setting('drevo.archive_id',true) AND ",
      );
  const candidates = [
    ["actual_people_first", sql],
    ["explicit_archive_people_first", explicitArchive(sql)],
    ["photo_first_same_predicates", photoFirst],
    ["explicit_archive_photo_first", explicitArchive(photoFirst)],
  ] as const;
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  try {
    await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
      archiveId,
    ]);
    await client.query("SET LOCAL statement_timeout='10s'");
    const role = (
      await client.query(
        "SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user",
      )
    ).rows[0];
    assert.equal(role.rolsuper, false);
    assert.equal(role.rolbypassrls, false);
    const indexes = (
      await client.query(`SELECT indexname,indexdef FROM pg_indexes
      WHERE schemaname=current_schema() AND indexname IN ('people_photo','photos_url') ORDER BY indexname`)
    ).rows;
    const plans = [];
    for (const [name, query] of candidates) {
      const allowed = await client.query(query, values);
      assert.equal(
        allowed.rowCount,
        1,
        `${name}: equivalent gallery reference must remain accessible`,
      );
      const result = await client.query(
        `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${query}`,
        values,
      );
      plans.push({ name, plan: result.rows[0]["QUERY PLAN"][0] });
    }
    return {
      operation: "media_reference_query_plans",
      scope:
        "synthetic archive owner/all gallery URL; ordinary role with FORCE RLS; measured before timed HTTP traffic",
      indexes,
      plans,
    };
  } finally {
    await client.query("ROLLBACK");
  }
}
