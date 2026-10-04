import assert from "node:assert/strict";
import pg from "pg";
import { openPostgresDatabase } from "../../src/server/store-database.ts";

// Run only in the disposable runtime fixture, after its initial migration.
// With the old archive-row-first initializer, the second pool waits for the
// archive row instead of reaching the global migration lock.
export async function verifyGlobalStaffMigrationStartup(
  observer: pg.Client, archiveId: string, source: string,
) {
  await observer.query(`DROP TRIGGER normalize_archive_member_role_before_write
    ON archive_memberships`);
  const gate = new pg.Client({ connectionTimeoutMillis: 5000 });
  await gate.connect();
  const opened: Awaited<ReturnType<typeof openPostgresDatabase>>[] = [];
  let starters: Promise<PromiseSettledResult<Awaited<ReturnType<typeof openPostgresDatabase>>>[]> | undefined;
  let results: PromiseSettledResult<Awaited<ReturnType<typeof openPostgresDatabase>>>[] = [];
  try {
    await gate.query("BEGIN");
    await gate.query("SELECT pg_advisory_xact_lock(186743291)");
    const gatePid = (await gate.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    starters = Promise.allSettled([
      openPostgresDatabase(archiveId, source),
      openPostgresDatabase(archiveId, source),
    ]);
    let waiting = 0;
    for (let attempt = 0; attempt < 300; attempt++) {
      waiting = Number((await observer.query(`SELECT count(*)::int AS count
        FROM pg_stat_activity WHERE datname=current_database()
          AND application_name='drevo' AND wait_event_type='Lock'
          AND $1=ANY(pg_blocking_pids(pid))
          AND query='SELECT pg_advisory_xact_lock(186743291)'`, [gatePid])).rows[0].count);
      if (waiting === 2) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(waiting, 2,
      "both independent pools must reach the global migration lock without holding the archive row");
  } finally {
    await gate.query("ROLLBACK").catch(() => {});
    await gate.end();
    if (starters) {
      results = await starters;
      for (const result of results)
        if (result.status === "fulfilled") opened.push(result.value);
      await Promise.all(opened.map((db) => db.close()));
    }
  }
  for (const result of results)
    if (result.status === "rejected") throw result.reason;
  assert.equal((await observer.query(`SELECT count(*)::int AS count FROM pg_trigger
    WHERE tgrelid='archive_memberships'::regclass
      AND tgname='normalize_archive_member_role_before_write'
      AND NOT tgisinternal`)).rows[0].count, 1);
}
