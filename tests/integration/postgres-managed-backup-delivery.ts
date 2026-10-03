import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { createServer, get as httpGet, type IncomingMessage } from "node:http";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import type pg from "pg";
import { backupManagementHttp } from "../../src/server/backup-management-http.ts";
import type { BackupCoordinator } from "../../src/server/backup-coordinator.ts";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { restoreStore } from "../../src/server/restore.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyManagedBackupDelivery(
  archive: Awaited<ReturnType<typeof openArchive>>,
  backups: BackupCoordinator,
  source: string,
  backupId: string,
  client: pg.Client,
) {
  const initialRevision = (await archive.meta()).revision;
  const createdHashes: string[] = [];
  const auth = await createAuth(await userStore(archive.db), archive.db,
    process.env.PUBLIC_ORIGIN);
  let reached!: () => void;
  let release!: () => void;
  let ready = new Promise<void>((resolve) => { reached = resolve; });
  let gate = new Promise<void>((resolve) => { release = resolve; });
  let completed!: () => void;
  let handled = new Promise<void>((resolve) => { completed = resolve; });
  let lockedBarrier: (() => Promise<void>) | undefined;
  const endpoint = backupManagementHttp({
    backups,
    restores: restoreStore(archive, source),
    auth,
    db: archive.db,
    beforeDelivery: async () => { reached(); await gate; },
    beforeLockedDelivery: async () => { await lockedBarrier?.(); },
  });
  const parallelEndpoints = Array.from({ length: 10 }, () => backupManagementHttp({
    backups, restores: restoreStore(archive, source), auth, db: archive.db,
  }));
  let finishParallel!: () => void;
  const parallelFinished = new Promise<void>((resolve) => { finishParallel = resolve; });
  let parallelHandled = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);
    const slot = Number(url.searchParams.get("parallel"));
    const route = url.searchParams.has("parallel") && Number.isInteger(slot) &&
      slot >= 0 && slot < parallelEndpoints.length ? parallelEndpoints[slot] : endpoint;
    void route(req, res, url).catch((error) => res.destroy(error))
      .finally(() => {
        if (route === endpoint) completed();
        else if (++parallelHandled === parallelEndpoints.length) finishParallel();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (token: string, id = backupId) => fetch(`${base}/api/backups/${id}/download`, {
    headers: { Cookie: `drevo_session=${token}` },
  });
  const atDelivery = async (pending: Promise<Response>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        ready,
        pending.then((response) => {
          throw new Error(`Managed backup responded before delivery barrier: ${response.status}`);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Managed backup did not reach delivery barrier")), 30_000);
          timer.unref();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  const resetGate = () => {
    ready = new Promise<void>((resolve) => { reached = resolve; });
    gate = new Promise<void>((resolve) => { release = resolve; });
    handled = new Promise<void>((resolve) => { completed = resolve; });
  };
  const beforeTimeout = async (value: Promise<void>, message: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([value, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 30_000);
        timer.unref();
      })]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  try {
    const token = newSessionToken();
    createdHashes.push(sessionTokenHash(token));
    await archive.db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES(?,'owner',?)`).run(sessionTokenHash(token), Date.now() + 60_000);
    try {
      const allowed = request(token);
      await atDelivery(allowed);
      release();
      const response = await allowed;
      assert.equal(response.status, 200);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
      await handled;

      resetGate();
      const loggedOut = request(token);
      await atDelivery(loggedOut);
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(token)]);
      release();
      const revokedSession = await loggedOut;
      assert.equal(revokedSession.status, 401,
        "completed logout before the first byte must not deliver a managed backup");
      assert.match(await revokedSession.text(), /отозван/);
      await handled;
    } finally {
      release();
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(token)]);
    }

    const secondToken = newSessionToken();
    createdHashes.push(sessionTokenHash(secondToken));
    await archive.db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES(?,'owner',?)`).run(sessionTokenHash(secondToken), Date.now() + 60_000);
    try {
      resetGate();
      const demoted = request(secondToken);
      await atDelivery(demoted);
      await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
      release();
      const revokedGrant = await demoted;
      assert.equal(revokedGrant.status, 403,
        "completed platform-admin revocation before the first byte must not deliver a managed backup");
      assert.match(await revokedGrant.text(), /отозван/);
      await handled;
    } finally {
      release();
      await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(secondToken)]);
    }

    const lockedToken = newSessionToken();
    createdHashes.push(sessionTokenHash(lockedToken));
    await archive.db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES(?,'owner',?)`).run(sessionTokenHash(lockedToken), Date.now() + 60_000);
    let lockedReached!: () => void;
    let unlock!: () => void;
    const atLock = new Promise<void>((resolve) => { lockedReached = resolve; });
    const lockGate = new Promise<void>((resolve) => { unlock = resolve; });
    lockedBarrier = async () => { lockedReached(); await lockGate; };
    try {
      resetGate();
      release();
      const underLock = request(lockedToken);
      await beforeTimeout(atLock, "Managed backup did not reach final access lock");
      const revocation = client.query("DELETE FROM platform_admins WHERE account_id='owner'");
      try {
        assert.equal(await Promise.race([
          revocation.then(() => "revoked"),
          new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
        ]), "waiting", "grant revocation waits through the first authorized backup write");
      } finally {
        unlock();
      }
      const response = await underLock;
      assert.equal(response.status, 200);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
      await handled;
      await revocation;
    } finally {
      unlock();
      lockedBarrier = undefined;
      await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(lockedToken)]);
    }

    const parallelToken = newSessionToken();
    createdHashes.push(sessionTokenHash(parallelToken));
    await archive.db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES(?,'owner',?)`).run(sessionTokenHash(parallelToken), Date.now() + 60_000);
    try {
      const downloads = await Promise.all(parallelEndpoints.map((_, slot) =>
        fetch(`${base}/api/backups/${backupId}/download?parallel=${slot}`, {
          headers: { Cookie: `drevo_session=${parallelToken}` },
          signal: AbortSignal.timeout(15_000),
        })));
      assert.deepEqual(downloads.map((response) => response.status),
        Array(parallelEndpoints.length).fill(200),
        "parallel final checks do not exhaust the PostgreSQL pool");
      assert.ok((await Promise.all(downloads.map((response) => response.arrayBuffer())))
        .every((bytes) => bytes.byteLength > 0));
      await beforeTimeout(parallelFinished, "Parallel backup handlers did not release their files");
    } finally {
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(parallelToken)]);
    }

    // A client that stops reading after the first chunk must not pin the
    // platform grant for the rest of a large original stream.
    const slowToken = newSessionToken();
    createdHashes.push(sessionTokenHash(slowToken));
    await archive.db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
      VALUES(?,'owner',?)`).run(sessionTokenHash(slowToken), Date.now() + 60_000);
    const fixtureId = randomUUID();
    const fixtureName = `full-20261003T000000Z-${fixtureId}.tar.gz`;
    const fixturePath = join(dirname(source), "backups", fixtureName);
    const fixtureBytes = gzipSync(randomBytes(16 * 1024 * 1024));
    writeFileSync(fixturePath, fixtureBytes);
    await archive.db.prepare("", `INSERT INTO backup_catalog(id,name,created_at,data)
      VALUES(?,?,?,?)`).run(fixtureId, fixtureName, new Date().toISOString(),
      JSON.stringify({ id: fixtureId, name: fixtureName, size: fixtureBytes.length,
        sha256: createHash("sha256").update(fixtureBytes).digest("hex"),
        createdAt: new Date().toISOString(), storage: "local",
        remoteHost: "", remoteDirectory: "" }));
    let slowResponse: IncomingMessage | undefined;
    let firstBytes!: () => void;
    const firstReceived = new Promise<void>((resolve) => { firstBytes = resolve; });
    resetGate();
    release();
    const slowRequest = httpGet(`${base}/api/backups/${fixtureId}/download`, {
      headers: { Cookie: `drevo_session=${slowToken}` },
    }, (response) => {
      assert.equal(response.statusCode, 200);
      response.on("error", () => {});
      response.once("data", (chunk: Buffer) => {
        assert.ok(chunk.length > 0);
        slowResponse = response;
        response.pause();
        firstBytes();
      });
    });
    slowRequest.on("error", () => {});
    try {
      await beforeTimeout(firstReceived, "Large backup did not send its first chunk");
      assert.equal(await Promise.race([
        handled.then(() => "finished"),
        new Promise<string>((resolve) => setTimeout(() => resolve("streaming"), 100)),
      ]), "streaming", "paused client keeps the remaining backup stream open");
      const revocation = client.query("DELETE FROM platform_admins WHERE account_id='owner'");
      assert.equal(await Promise.race([
        revocation.then(() => "revoked"),
        new Promise<string>((resolve) => setTimeout(() => resolve("blocked"), 2_000)),
      ]), "revoked", "slow backup stream does not hold platform-admin DB locks");
      await revocation;
    } finally {
      slowResponse?.destroy();
      slowRequest.destroy();
      await handled;
      await client.query("INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING");
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(slowToken)]);
      await archive.db.prepare("", "DELETE FROM backup_catalog WHERE id=?").run(fixtureId);
      rmSync(fixturePath, { force: true });
      assert.equal(existsSync(fixturePath), false);
      assert.equal((await archive.db.prepare("", "SELECT 1 FROM backup_catalog WHERE id=?")
        .get(fixtureId)), undefined);
    }
  } finally {
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const hash of createdHashes)
    assert.equal((await archive.db.prepare("", "SELECT 1 FROM account_sessions WHERE token_hash=?")
      .get(hash)), undefined, "test download sessions are removed");
  assert.ok(await archive.db.prepare("", "SELECT 1 FROM platform_admins WHERE account_id='owner'")
    .get(), "the platform grant is restored after each race");
  assert.equal((await archive.meta()).revision, initialRevision,
    "backup delivery races do not mutate the archive graph");
  console.log("postgres_managed_backup_delivery_verified");
}
