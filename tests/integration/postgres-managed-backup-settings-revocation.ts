import assert from "node:assert/strict";
import { createServer } from "node:http";
import type pg from "pg";
import { backupManagementHttp } from "../../src/server/backup-management-http.ts";
import type { BackupCoordinator } from "../../src/server/backup-coordinator.ts";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { restoreStore } from "../../src/server/restore.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { userStore } from "../../src/server/users.ts";
import { canManageTreeBackups } from "../../src/domain/access.ts";

export async function verifyManagedBackupSettingsRevocation(
  archive: Awaited<ReturnType<typeof openArchive>>,
  backups: BackupCoordinator,
  source: string,
  client: pg.Client,
) {
  const auth = await createAuth(await userStore(archive.db), archive.db,
    process.env.PUBLIC_ORIGIN);
  const original = await archive.db.prepare("", "SELECT data,next_run FROM backup_settings WHERE id=1").get();
  assert.ok(original);
  const originalData = String(original.data);
  const current = (await backups.status("owner")).settings;
  const changed = { ...current, intervalHours: current.intervalHours === 720 ? 719 : current.intervalHours + 1 };
  const restoreSettings = async () => archive.db.prepare("", "UPDATE backup_settings SET data=?,next_run=? WHERE id=1")
    .run(originalData, Number(original.next_run));
  const readSettings = async () => archive.db.prepare("", "SELECT data,next_run FROM backup_settings WHERE id=1").get();
  const auditCount = async () => Number((await archive.db.prepare("", `SELECT count(*) AS n
    FROM archive_audit_entries WHERE entity='settings' AND entity_id='backups'`).get())?.n);
  let reached!: () => void;
  let release!: () => void;
  let ready = new Promise<void>((resolve) => { reached = resolve; });
  let gate = new Promise<void>((resolve) => { release = resolve; });
  let authorizationChecks = 0;
  const resetGate = () => {
    ready = new Promise<void>((resolve) => { reached = resolve; });
    gate = new Promise<void>((resolve) => { release = resolve; });
    authorizationChecks = 0;
  };
  const guardedAuth = {
    ...auth,
    // This coordinator deliberately tests the retained legacy internal settings
    // path; production treeOnly coordinators reject settings before this path.
    currentUser: async (...args: Parameters<typeof auth.currentUser>) => {
      const actor = await auth.currentUser(...args);
      if (canManageTreeBackups(actor) && ++authorizationChecks === 2) {
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
  const request = (token: string) => fetch(`${base}/api/backups/settings`, {
    method: "PUT",
    headers: {
      Cookie: `drevo_session=${token}`,
      Origin: base,
      "Content-Type": "application/json",
      "X-Drevo-Backup": "1",
    },
    body: JSON.stringify(changed),
  });
  const waitForSave = async (pending: Promise<Response>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        pending.then((response) => {
          throw new Error(`Backup settings responded before save barrier: ${response.status}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Backup settings did not reach save barrier")), 30_000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const outcomes: Array<{ kind: string; status: number; changed: boolean; body: string }> = [];
  try {
    const auditBefore = await auditCount();
    const normal = await insertSession();
    try {
      const pending = request(normal.token);
      await waitForSave(pending);
      release();
      const response = await pending;
      assert.equal(response.status, 200, await response.text());
      assert.notEqual(String((await readSettings())?.data), originalData);
    } finally {
      release();
      await restoreSettings();
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [normal.hash]);
    }
    assert.equal(await auditCount(), auditBefore + 1, "an authorized save records one audit entry");
    const authorizedAuditCount = await auditCount();

    for (const kind of ["logout", "platform-grant", "membership"] as const) {
      resetGate();
      const session = await insertSession();
      try {
        const pending = request(session.token);
        await waitForSave(pending);
        if (kind === "logout")
          await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [session.hash]);
        else if (kind === "platform-grant")
          await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
        else
          await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id='owner'",
            [archive.db.archiveId]);
        release();
        const response = await pending;
        const body = await response.text();
        outcomes.push({ kind, status: response.status,
          changed: String((await readSettings())?.data) !== originalData, body });
        assert.equal(await auditCount(), authorizedAuditCount,
          `a revoked ${kind} save must not leave an audit entry`);
      } finally {
        release();
        if (kind === "platform-grant")
          await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
        else if (kind === "membership")
          await client.query("UPDATE archive_memberships SET approved=true WHERE archive_id=$1 AND user_id='owner'",
            [archive.db.archiveId]);
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [session.hash]);
        await restoreSettings();
      }
    }
    assert.deepEqual(outcomes.map(({ kind, status, changed }) => ({ kind, status, changed })), [
      { kind: "logout", status: 401, changed: false },
      { kind: "platform-grant", status: 403, changed: false },
      { kind: "membership", status: 403, changed: false },
    ], "completed revocation before the settings write must prevent the persistent change");
    for (const outcome of outcomes)
      assert.doesNotMatch(outcome.body, /remoteHost|remoteDirectory|intervalHours/);

    for (const kind of ["grant-lock", "audit-lock"] as const) {
      resetGate();
      const session = await insertSession();
      try {
        const pending = request(session.token);
        await waitForSave(pending);
        await client.query("BEGIN");
        try {
          if (kind === "grant-lock")
            await client.query("SELECT account_id FROM platform_admins WHERE account_id='owner' FOR UPDATE");
          else
            await client.query("LOCK TABLE archive_audit_entries IN ACCESS EXCLUSIVE MODE");
          release();
          const response = await pending;
          assert.equal(response.status, 409, `${kind} must fail closed on contention`);
          assert.doesNotMatch(await response.text(), /remoteHost|remoteDirectory|intervalHours/);
        } finally {
          await client.query("ROLLBACK");
        }
        assert.equal(String((await readSettings())?.data), originalData,
          `${kind} must roll back the settings change`);
        assert.equal(await auditCount(), authorizedAuditCount,
          `${kind} must not add an audit entry`);
      } finally {
        release();
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [session.hash]);
      }
    }
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(String((await readSettings())?.data), originalData);
  console.log("postgres_managed_backup_settings_revocation_verified");
}
