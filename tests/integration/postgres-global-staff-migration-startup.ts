import assert from "node:assert/strict";
import pg from "pg";
import { openPostgresDatabase } from "../../src/server/store-database.ts";

// Run only in the disposable runtime fixture, after its initial migration.
// With the old archive-row-first initializer, the second pool waits for the
// archive row instead of reaching the global migration lock.
export async function verifyGlobalStaffMigrationStartup(
  observer: pg.Client,
  archiveId: string,
  source: string,
) {
  // Both extensions acquire AccessExclusive locks on a shared relation.
  // Drop only their readiness marker in the disposable fixture; reopening
  // must serialize the DDL without first retaining an archive row lock.
  for (const extension of ["staff", "invitation-scope"] as const) {
    await observer.query(
      extension === "staff"
        ? `DROP TRIGGER normalize_archive_member_role_before_write ON archive_memberships`
        : `ALTER TABLE archive_invitations DROP CONSTRAINT archive_invitation_scope_check`,
    );
    const gate = new pg.Client({ connectionTimeoutMillis: 5000 });
    await gate.connect();
    const opened: Awaited<ReturnType<typeof openPostgresDatabase>>[] = [];
    let starters:
      | Promise<
          PromiseSettledResult<
            Awaited<ReturnType<typeof openPostgresDatabase>>
          >[]
        >
      | undefined;
    let results: PromiseSettledResult<
      Awaited<ReturnType<typeof openPostgresDatabase>>
    >[] = [];
    try {
      await gate.query("BEGIN");
      await gate.query("SELECT pg_advisory_xact_lock(186743291)");
      const gatePid = (await gate.query("SELECT pg_backend_pid() AS pid"))
        .rows[0].pid;
      starters = Promise.allSettled([
        openPostgresDatabase(archiveId, source),
        openPostgresDatabase(archiveId, source),
      ]);
      let waiting = 0;
      for (let attempt = 0; attempt < 300; attempt++) {
        waiting = Number(
          (
            await observer.query(
              `SELECT count(*)::int AS count
        FROM pg_stat_activity WHERE datname=current_database()
          AND application_name='drevo' AND wait_event_type='Lock'
          AND $1=ANY(pg_blocking_pids(pid))
          AND query='SELECT pg_advisory_xact_lock(186743291)'`,
              [gatePid],
            )
          ).rows[0].count,
        );
        if (waiting === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal(
        waiting,
        2,
        `${extension}: both independent pools must reach the global migration lock without holding the archive row`,
      );
      // An invitation accept/revoke transaction must still be able to acquire
      // the archive while startup waits on the global migration operator.
      await observer.query("BEGIN");
      try {
        await observer.query("SET LOCAL lock_timeout='1s'");
        assert.equal((await observer.query("SELECT id FROM archives WHERE id=$1 FOR UPDATE", [
          archiveId,
        ])).rowCount, 1, "the invitation archive row remains lockable while both startups wait");
      } finally {
        await observer.query("ROLLBACK");
      }
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
    assert.equal(
      (
        await observer.query(
          extension === "staff"
            ? `SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgrelid='archive_memberships'::regclass
        AND tgname='normalize_archive_member_role_before_write' AND NOT tgisinternal`
            : `SELECT count(*)::int AS count FROM pg_constraint
      WHERE conrelid='archive_invitations'::regclass AND conname='archive_invitation_scope_check'`,
        )
      ).rows[0].count,
      1,
    );
  }
}
