import assert from "node:assert/strict";
import { createServer } from "node:http";
import type pg from "pg";
import { backupManagementHttp } from "../../src/server/backup-management-http.ts";
import { backupCoordinator } from "../../src/server/backup-coordinator.ts";
import type { BackupRemote } from "../../src/server/backup-remote.ts";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { restoreStore } from "../../src/server/restore.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { userStore } from "../../src/server/users.ts";
import { canManageTreeBackups } from "../../src/domain/access.ts";

export async function verifyManagedBackupCheckRevocation(
  archive: Awaited<ReturnType<typeof openArchive>>,
  source: string,
  client: pg.Client,
) {
  let probes = 0;
  let uploads = 0;
  let probeGate: Promise<void> | undefined;
  let probeReached: (() => void) | undefined;
  let uploadGate: Promise<void> | undefined;
  let uploadReached: (() => void) | undefined;
  const remote: BackupRemote = {
    config: "test-only-ssh-config",
    async check() {
      probes++;
      probeReached?.();
      await probeGate;
    },
    async upload() {
      uploads++;
      uploadReached?.();
      await uploadGate;
    },
    async download() { throw new Error("Unexpected backup download"); },
    async remove() { throw new Error("Unexpected backup removal"); },
  };
  const backups = await backupCoordinator(archive.db, source, { schedule: false, remote });
  const auth = await createAuth(await userStore(archive.db), archive.db,
    process.env.PUBLIC_ORIGIN);
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
    else
      await archive.db.prepare("", "DELETE FROM backup_job WHERE id=1").run();
  };
  const jobId = async () => {
    const row = await archive.db.prepare("", "SELECT data FROM backup_job WHERE id=1").get();
    return row ? (JSON.parse(String(row.data)) as { id: string }).id : null;
  };
  let reached!: () => void;
  let release!: () => void;
  let ready = new Promise<void>((resolve) => { reached = resolve; });
  let gate = new Promise<void>((resolve) => { release = resolve; });
  let authorizationChecks = 0;
  let createReads = 0;
  const resetGate = () => {
    ready = new Promise<void>((resolve) => { reached = resolve; });
    gate = new Promise<void>((resolve) => { release = resolve; });
    authorizationChecks = 0;
    createReads = 0;
  };
  const guardedAuth = {
    ...auth,
    currentUser: async (...args: Parameters<typeof auth.currentUser>) => {
      const actor = await auth.currentUser(...args);
      if (args[0].url === "/api/backups/create" && actor && ++createReads === 2) {
        reached();
        await gate;
      }
      if (args[0].url === "/api/backups/check" && canManageTreeBackups(actor) && ++authorizationChecks === 2) {
        reached();
        await gate;
      }
      return actor;
    },
  };
  const endpoint = backupManagementHttp({
    backups,
    restores: restoreStore(archive, source),
    auth: guardedAuth,
    db: archive.db,
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
  const request = (token: string) => fetch(`${base}/api/backups/check`, {
    method: "POST",
    headers: {
      Cookie: `drevo_session=${token}`,
      Origin: base,
      "Content-Type": "application/json",
      "X-Drevo-Backup": "1",
    },
    body: JSON.stringify({ enabled: false, intervalHours: 24, keepCount: 1,
      storage: "remote", remoteHost: "fixture-host", remoteDirectory: "/fixture-backups" }),
  });
  const waitForCheck = async (pending: Promise<Response>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        pending.then((response) => {
          throw new Error(`Backup check responded before access barrier: ${response.status}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Backup check did not reach access barrier")), 30_000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const outcomes: Array<{ kind: string; status: number; queued: boolean; probed: boolean }> = [];
  try {
    const normal = await insertSession();
    try {
      const before = await jobId();
      const beforeProbes = probes;
      const pending = request(normal.token);
      await waitForCheck(pending);
      release();
      const response = await pending;
      assert.equal(response.status, 202, await response.text());
      await backups.idle();
      assert.notEqual(await jobId(), before, "authorized check creates a new job");
      assert.equal(probes, beforeProbes + 1, "authorized check probes the injected remote");
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
        const beforeProbes = probes;
        const pending = request(session.token);
        await waitForCheck(pending);
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
          queued: (await jobId()) !== before, probed: probes !== beforeProbes });
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
      { kind: "logout", status: 401, queued: false, probed: false },
      { kind: "platform-grant", status: 403, queued: false, probed: false },
      { kind: "membership", status: 403, queued: false, probed: false },
      { kind: "owner-transfer", status: 403, queued: false, probed: false },
    ], "completed revocation before job creation must prevent the remote check");

    for (const kind of ["logout", "platform-grant", "membership", "owner-transfer"] as const) {
      resetGate();
      const session = await insertSession();
      try {
        const before = await jobId();
        const pending = fetch(`${base}/api/backups/create`, {
          method: "POST", headers: { Cookie: `drevo_session=${session.token}`,
            Origin: base, "X-Drevo-Backup": "1" },
        });
        await waitForCheck(pending);
        if (kind === "logout")
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [session.hash]);
        else if (kind === "platform-grant")
          await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
        else if (kind === "membership")
          await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id='owner'",
            [archive.db.archiveId]);
        else
          await client.query("UPDATE archive_owners SET user_id='vk:42' WHERE archive_id=$1", [archive.db.archiveId]);
        release();
        const response = await pending;
        assert.equal(response.status, kind === "logout" ? 401 : 403, await response.text());
        assert.equal(await jobId(), before, "revocation before create claim must not queue a job");
        assert.equal(uploads, 0, "revoked create never reaches the injected backup upload");
      } finally {
        release();
        if (kind === "platform-grant")
          await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
        else if (kind === "membership")
          await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id=$1 AND user_id='owner'",
            [archive.db.archiveId]);
        else if (kind === "owner-transfer")
          await client.query("UPDATE archive_owners SET user_id='owner' WHERE archive_id=$1", [archive.db.archiveId]);
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [session.hash]);
        await restoreJob();
      }
    }

    resetGate();
    const contended = await insertSession();
    try {
      const before = await jobId();
      const beforeProbes = probes;
      const pending = request(contended.token);
      await waitForCheck(pending);
      await client.query("BEGIN");
      await client.query("SELECT account_id FROM platform_admins WHERE account_id='owner' FOR UPDATE");
      release();
      const response = await pending;
      assert.equal(response.status, 409, await response.text());
      assert.equal(await jobId(), before, "contended final grant leaves no queued job");
      assert.equal(probes, beforeProbes, "contended final grant does not probe remote");
    } finally {
      release();
      await client.query("ROLLBACK");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [contended.hash]);
    }

    resetGate();
    const authorized = await insertSession();
    let resumeProbe!: () => void;
    let startedProbe!: () => void;
    probeGate = new Promise<void>((resolve) => { resumeProbe = resolve; });
    const started = new Promise<void>((resolve) => { startedProbe = resolve; });
    probeReached = startedProbe;
    try {
      const pending = request(authorized.token);
      await waitForCheck(pending);
      release();
      const response = await pending;
      assert.equal(response.status, 202, await response.text());
      await started;
      await Promise.race([
        client.query("DELETE FROM platform_admins WHERE account_id='owner'"),
        new Promise<never>((_, reject) => setTimeout(() => reject(
          new Error("remote probe kept the platform grant locked after job claim")), 5000)),
      ]);
      assert.ok(await jobId(), "authorized job persists after later grant revocation");
      resumeProbe();
      await backups.idle();
      const completed = await archive.db.prepare("", "SELECT data FROM backup_job WHERE id=1").get();
      assert.equal((JSON.parse(String(completed?.data)) as { state: string }).state, "succeeded",
        "a previously authorized system check may finish after later revocation");
    } finally {
      release();
      resumeProbe();
      await backups.idle();
      probeGate = undefined;
      probeReached = undefined;
      await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [authorized.hash]);
      await restoreJob();
    }

    // The real create endpoint may continue an already committed job after
    // revocation. Block only the synthetic remote upload, never a live provider.
    resetGate();
    const createSession = await insertSession();
    const originalSettings = await archive.db.prepare("", "SELECT data,next_run FROM backup_settings WHERE id=1").get();
    const originalCatalog = new Set((await archive.db.prepare("", "SELECT id FROM backup_catalog").all())
      .map((row) => String(row.id)));
    let resumeUpload!: () => void;
    let startedUpload!: () => void;
    uploadGate = new Promise<void>((resolve) => { resumeUpload = resolve; });
    const uploadStarted = new Promise<void>((resolve) => { startedUpload = resolve; });
    uploadReached = startedUpload;
    try {
      await archive.db.prepare("", "UPDATE backup_settings SET data=? WHERE id=1")
        .run(JSON.stringify({ enabled: false, intervalHours: 24, keepCount: 10,
          storage: "remote", remoteHost: "fixture-host", remoteDirectory: "/fixture-backups" }));
      const pending = fetch(`${base}/api/backups/create`, {
        method: "POST", headers: { Cookie: `drevo_session=${createSession.token}`,
          Origin: base, "X-Drevo-Backup": "1" },
      });
      await waitForCheck(pending);
      release();
      const response = await pending;
      assert.equal(response.status, 202, await response.text());
      await Promise.race([uploadStarted, new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Synthetic backup upload did not start")), 30_000);
        timer.unref();
      })]);
      await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
      assert.ok(await jobId(), "create job remains durably claimed after grant revocation");
      resumeUpload();
      await backups.idle();
      const completed = await archive.db.prepare("", "SELECT data FROM backup_job WHERE id=1").get();
      assert.equal((JSON.parse(String(completed?.data)) as { state: string }).state, "succeeded",
        "a previously authorized create is not falsely rolled back after revocation");
      assert.equal(uploads, 1);
    } finally {
      release();
      resumeUpload();
      await backups.idle();
      uploadGate = undefined;
      uploadReached = undefined;
      await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [createSession.hash]);
      if (originalSettings)
        await archive.db.prepare("", "UPDATE backup_settings SET data=?,next_run=? WHERE id=1")
          .run(String(originalSettings.data), Number(originalSettings.next_run));
      for (const row of await archive.db.prepare("", "SELECT id FROM backup_catalog").all())
        if (!originalCatalog.has(String(row.id)))
          await archive.db.prepare("", "DELETE FROM backup_catalog WHERE id=?").run(String(row.id));
      await restoreJob();
    }
  } finally {
    release();
    await backups.idle();
    await restoreJob();
    await archive.db.prepare("", `DELETE FROM archive_audit_entries
      WHERE id>? AND entity='settings' AND entity_id='backups'`).run(auditBefore);
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await backups.close();
  }
  console.log("postgres_managed_backup_check_revocation_verified");
}
