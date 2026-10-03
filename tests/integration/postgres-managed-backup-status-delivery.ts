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

export async function verifyManagedBackupStatusDelivery(
  archive: Awaited<ReturnType<typeof openArchive>>,
  backups: BackupCoordinator,
  source: string,
  recordId: string,
  client: pg.Client,
) {
  const auth = await createAuth(await userStore(archive.db), archive.db,
    process.env.PUBLIC_ORIGIN);
  let reached!: () => void;
  let release!: () => void;
  let ready = new Promise<void>((resolve) => { reached = resolve; });
  let gate = new Promise<void>((resolve) => { release = resolve; });
  const guardedBackups = {
    ...backups,
    status: async (...args: Parameters<BackupCoordinator["status"]>) => {
      const result = await backups.status(...args);
      reached();
      await gate;
      return result;
    },
  };
  const endpoint = backupManagementHttp({
    backups: guardedBackups,
    restores: restoreStore(archive, source),
    auth,
    db: archive.db,
  });
  const server = createServer((req, res) => {
    void endpoint(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const resetGate = () => {
    ready = new Promise<void>((resolve) => { reached = resolve; });
    gate = new Promise<void>((resolve) => { release = resolve; });
  };
  const waitForStatus = async (pending: Promise<Response>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        pending.then((response) => {
          throw new Error(`Managed backup status responded before barrier: ${response.status}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Managed backup status did not reach barrier")), 30_000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const sessionHashes: string[] = [];
  const insertSession = async () => {
    const token = newSessionToken();
    const hash = sessionTokenHash(token);
    sessionHashes.push(hash);
    await archive.db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES(?,'owner',?)`).run(hash, Date.now() + 60_000);
    return { token, hash };
  };
  const request = (token: string) => fetch(`${base}/api/backups`, {
    headers: { Cookie: `drevo_session=${token}` },
  });
  try {
    const normal = await insertSession();
    try {
      const pending = request(normal.token);
      await waitForStatus(pending);
      release();
      const response = await pending;
      assert.equal(response.status, 200);
      const body = await response.json() as {
        localDirectory: string; sshConfig: string; records: Array<{ id: string }>;
      };
      assert.ok(body.localDirectory.includes("backups"));
      assert.equal(typeof body.sshConfig, "string");
      assert.ok(body.records.some((record) => record.id === recordId));
    } finally {
      release();
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [normal.hash]);
    }

    resetGate();
    const logout = await insertSession();
    let logoutStatus: number;
    let logoutBody: string;
    try {
      const pending = request(logout.token);
      await waitForStatus(pending);
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [logout.hash]);
      release();
      const response = await pending;
      logoutStatus = response.status;
      logoutBody = await response.text();
    } finally {
      release();
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [logout.hash]);
    }

    resetGate();
    const demoted = await insertSession();
    let demotedStatus: number;
    let demotedBody: string;
    try {
      const pending = request(demoted.token);
      await waitForStatus(pending);
      await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
      release();
      const response = await pending;
      demotedStatus = response.status;
      demotedBody = await response.text();
    } finally {
      release();
      await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [demoted.hash]);
    }
    assert.deepEqual([logoutStatus, demotedStatus], [401, 403],
      "completed revocation after status assembly must not disclose the backup catalog");
    for (const body of [logoutBody, demotedBody]) {
      assert.match(body, /"error"/);
      assert.doesNotMatch(body, /localDirectory|sshConfig|remoteDirectory|sha256/);
    }

    resetGate();
    const busy = await insertSession();
    try {
      const pending = request(busy.token);
      await waitForStatus(pending);
      await client.query("BEGIN");
      try {
        await client.query("SELECT account_id FROM platform_admins WHERE account_id='owner' FOR UPDATE");
        release();
        const response = await pending;
        assert.equal(response.status, 409, "contended final grant lock must fail closed");
        assert.doesNotMatch(await response.text(), /localDirectory|sshConfig|remoteDirectory|sha256/);
      } finally {
        await client.query("ROLLBACK");
      }
    } finally {
      release();
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [busy.hash]);
    }
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const hash of sessionHashes)
    assert.equal(await archive.db.prepare("", "SELECT 1 FROM account_sessions WHERE token_hash=?")
      .get(hash), undefined);
  assert.ok(await archive.db.prepare("", "SELECT 1 FROM platform_admins WHERE account_id='owner'")
    .get());
  console.log("postgres_managed_backup_status_delivery_verified");
}
