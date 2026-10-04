import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type pg from "pg";
import { backupManagementHttp } from "../../src/server/backup-management-http.ts";
import { backupCoordinator } from "../../src/server/backup-coordinator.ts";
import type { BackupRemote } from "../../src/server/backup-remote.ts";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { restoreStore } from "../../src/server/restore.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyManagedBackupPreviewRevocation(
  archive: Awaited<ReturnType<typeof openArchive>>,
  source: string,
  client: pg.Client,
) {
  const recordId = randomUUID();
  const name = `full-20260101T000000Z-${recordId}.tar.gz`;
  const record = { id: recordId, name, createdAt: new Date().toISOString(),
    size: 1, sha256: createHash("sha256").update("x").digest("hex"), storage: "remote",
    remoteHost: "fixture-host", remoteDirectory: "/fixture-backups" };
  await archive.db.prepare("", `INSERT INTO backup_catalog(id,name,created_at,data)
    VALUES(?,?,?,?)`).run(recordId, name, record.createdAt, JSON.stringify(record));
  const originalJob = await archive.db.prepare("", `SELECT owner,actor_id,lease_until,data
    FROM backup_job WHERE id=1`).get();
  const auditBefore = Number((await archive.db.prepare("", `SELECT coalesce(max(id),0) AS id
    FROM archive_audit_entries`).get())?.id);
  const restoreJob = async () => {
    if (originalJob)
      await archive.db.prepare("", `UPDATE backup_job
        SET owner=?,actor_id=?,lease_until=?,data=? WHERE id=1`)
        .run(String(originalJob.owner), String(originalJob.actor_id),
          Number(originalJob.lease_until), String(originalJob.data));
    else await archive.db.prepare("", "DELETE FROM backup_job WHERE id=1").run();
  };
  const jobId = async () => {
    const row = await archive.db.prepare("", "SELECT data FROM backup_job WHERE id=1").get();
    return row ? (JSON.parse(String(row.data)) as { id: string }).id : null;
  };
  let reached!: () => void;
  let release!: () => void;
  let ready = new Promise<void>((resolve) => { reached = resolve; });
  let gate = new Promise<void>((resolve) => { release = resolve; });
  let paused = false;
  const resetGate = () => {
    ready = new Promise<void>((resolve) => { reached = resolve; });
    gate = new Promise<void>((resolve) => { release = resolve; });
    paused = false;
  };
  // Pause the real awaited catalog read after initial HTTP authorization and
  // before the coordinator's job claim; later background reads are not paused.
  const guardedDb: StoreDatabase = {
    ...archive.db,
    prepare(sqlite, postgres) {
      const statement = archive.db.prepare(sqlite, postgres);
      if (!sqlite.includes("SELECT data FROM backup_catalog WHERE id=?")) return statement;
      return { ...statement, async get(...values) {
        const row = await statement.get(...values);
        if (row && !paused) {
          paused = true;
          reached();
          await gate;
        }
        return row;
      } };
    },
  };
  let downloads = 0;
  let downloadGate: Promise<void> | undefined;
  let downloadReached: (() => void) | undefined;
  const remote: BackupRemote = {
    config: "test-only-ssh-config",
    async download(_record, destination) {
      downloads++;
      downloadReached?.();
      await downloadGate;
      await writeFile(destination, "x");
    },
    async check() { throw new Error("Unexpected remote check"); },
    async upload() { throw new Error("Unexpected remote upload"); },
    async remove() { throw new Error("Unexpected remote removal"); },
  };
  const backups = await backupCoordinator(guardedDb, source, { schedule: false, remote });
  const auth = await createAuth(await userStore(archive.db), archive.db,
    process.env.PUBLIC_ORIGIN);
  const endpoint = backupManagementHttp({
    backups, restores: restoreStore(archive, source), auth, db: archive.db,
  });
  const server = createServer((req, res) => {
    void endpoint(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const insertSession = async () => {
    const token = newSessionToken();
    const hash = sessionTokenHash(token);
    await archive.db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES(?,'owner',?)`).run(hash, Date.now() + 60_000);
    return { token, hash };
  };
  const request = (token: string) => fetch(`${base}/api/backups/${recordId}/preview`, {
    method: "POST",
    headers: { Cookie: `drevo_session=${token}`, Origin: base,
      "Content-Type": "application/json", "X-Drevo-Backup": "1" },
    body: "{}",
  });
  const waitForRead = async (pending: Promise<Response>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        pending.then((response) => {
          throw new Error(`Backup preview responded before catalog-read barrier: ${response.status}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Backup preview did not reach catalog read")), 30_000);
          timer.unref();
        }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
  };
  const outcomes: Array<{ kind: string; status: number; queued: boolean; downloaded: boolean }> = [];
  try {
    const normal = await insertSession();
    try {
      const before = await jobId();
      const beforeDownloads = downloads;
      const pending = request(normal.token);
      await waitForRead(pending);
      release();
      const response = await pending;
      assert.equal(response.status, 202, await response.text());
      await backups.idle();
      assert.notEqual(await jobId(), before, "authorized preview creates a job");
      assert.equal(downloads, beforeDownloads + 1, "authorized preview attempts remote download");
    } finally {
      release();
      await backups.idle();
      await restoreJob();
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [normal.hash]);
    }
    for (const kind of ["logout", "platform-grant", "membership", "owner-transfer"] as const) {
      resetGate();
      const session = await insertSession();
      try {
        const before = await jobId();
        const beforeDownloads = downloads;
        const pending = request(session.token);
        await waitForRead(pending);
        if (kind === "logout")
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [session.hash]);
        else if (kind === "platform-grant")
          await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
        else if (kind === "owner-transfer")
          await client.query("UPDATE archive_owners SET user_id='vk:42' WHERE archive_id=$1", [archive.db.archiveId]);
        else
          await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id='owner'",
            [archive.db.archiveId]);
        release();
        const response = await pending;
        await response.text();
        await backups.idle();
        outcomes.push({ kind, status: response.status,
          queued: (await jobId()) !== before, downloaded: downloads !== beforeDownloads });
      } finally {
        release();
        await backups.idle();
        if (kind === "platform-grant")
          await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
        else if (kind === "owner-transfer")
          await client.query("UPDATE archive_owners SET user_id='owner' WHERE archive_id=$1", [archive.db.archiveId]);
        else if (kind === "membership")
          await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id=$1 AND user_id='owner'",
            [archive.db.archiveId]);
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [session.hash]);
        await restoreJob();
      }
    }
    assert.deepEqual(outcomes, [
      { kind: "logout", status: 401, queued: false, downloaded: false },
      { kind: "platform-grant", status: 403, queued: false, downloaded: false },
      { kind: "membership", status: 403, queued: false, downloaded: false },
      { kind: "owner-transfer", status: 403, queued: false, downloaded: false },
    ], "completed revocation before job claim must prevent remote preview download");

    resetGate();
    const authorized = await insertSession();
    let resumeDownload!: () => void;
    let startedDownload!: () => void;
    downloadGate = new Promise<void>((resolve) => { resumeDownload = resolve; });
    const started = new Promise<void>((resolve) => { startedDownload = resolve; });
    downloadReached = startedDownload;
    try {
      const pending = request(authorized.token);
      await waitForRead(pending);
      release();
      const response = await pending;
      assert.equal(response.status, 202, await response.text());
      await started;
      const stagesBefore = Number((await archive.db.prepare("", `SELECT count(*) AS count
        FROM workflow_stages WHERE kind='restore' AND actor_id='owner'`).get())?.count);
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          client.query("DELETE FROM platform_admins WHERE account_id='owner'"),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error(
              "remote download kept the platform grant locked after job claim")), 5000);
          }),
        ]);
      } finally { if (timeout) clearTimeout(timeout); }
      resumeDownload();
      await backups.idle();
      const completed = await archive.db.prepare("", "SELECT data FROM backup_job WHERE id=1").get();
      const job = JSON.parse(String(completed?.data)) as { state: string; error?: string };
      assert.equal(job.state, "failed");
      assert.equal(job.error, "Доступ администратора отозван.",
        "the post-download access check rejects the revoked administrator");
      assert.equal(Number((await archive.db.prepare("", `SELECT count(*) AS count
        FROM workflow_stages WHERE kind='restore' AND actor_id='owner'`).get())?.count),
      stagesBefore, "revoked preview leaves no restore stage");
    } finally {
      release();
      resumeDownload();
      await backups.idle();
      downloadGate = undefined;
      downloadReached = undefined;
      await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [authorized.hash]);
      await restoreJob();
    }
  } finally {
    release();
    await backups.idle();
    await restoreJob();
    await archive.db.prepare("", `DELETE FROM archive_audit_entries
      WHERE id>? AND entity='settings' AND entity_id='backups'`).run(auditBefore);
    await archive.db.prepare("", "DELETE FROM backup_catalog WHERE id=?").run(recordId);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await backups.close();
  }
  console.log("postgres_managed_backup_preview_revocation_verified");
}
