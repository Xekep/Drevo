import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import type { Client, PoolClient } from "pg";
import { createAuth } from "../../src/server/auth.ts";
import type { openArchive } from "../../src/server/database.ts";
import { offlinePackageHttp } from "../../src/server/offline-package-http.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyOfflineExportDelivery(
  archive: Awaited<ReturnType<typeof openArchive>>,
  client: Client,
  uploadsDirectory: string,
) {
  const db = archive.db;
  const archiveId = db.archiveId;
  const accountId = "offline-export-delivery-reader";
  const raceAccountId = "offline-export-race-reader";
  const stallAccountId = "offline-export-stall-reader";
  const origin = "https://offline-export-delivery.invalid";
  const revokedToken = newSessionToken();
  const memberToken = newSessionToken();
  const raceToken = newSessionToken();
  const stallToken = newSessionToken();
  const recoveryToken = newSessionToken();
  const revokedHash = sessionTokenHash(revokedToken);
  const memberHash = sessionTokenHash(memberToken);
  const raceHash = sessionTokenHash(raceToken);
  const stallHash = sessionTokenHash(stallToken);
  const recoveryHash = sessionTokenHash(recoveryToken);
  const previousContext = (await client.query<{ archive_id: string | null }>(
    "SELECT current_setting('drevo.archive_id',true) AS archive_id",
  )).rows[0].archive_id;
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Offline export reader',$2)",
    [accountId, new Date().toISOString()]);
  await client.query("INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,$2,'reader',true,'all')",
    [archiveId, accountId]);
  await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$3,$4),($2,$3,$4)",
    [revokedHash, memberHash, accountId, Date.now() + 600_000]);
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Offline race reader',$2)",
    [raceAccountId, new Date().toISOString()]);
  await client.query("INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,$2,'reader',true,'all')",
    [archiveId, raceAccountId]);
  await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
    [raceHash, raceAccountId, Date.now() + 600_000]);
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Offline stall reader',$2)",
    [stallAccountId, new Date().toISOString()]);
  await client.query("INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,$2,'reader',true,'all')",
    [archiveId, stallAccountId]);
  await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$3,$4),($2,$3,$4)",
    [stallHash, recoveryHash, stallAccountId, Date.now() + 600_000]);
  const auth = await createAuth(await userStore(db), db, origin);
  let barrier: { reached: () => void; gate: Promise<void> } | null = null;
  let transactionBarrier: { reached: () => void; gate: Promise<void>; skip: number } | null = null;
  const releases: Array<() => void> = [];
  const newBarrier = () => {
    let reached!: () => void;
    let release!: () => void;
    const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    releases.push(release);
    return { reached: reachedPromise, release, signal: reached, gate };
  };
  const pauseAfterFinalRead = () => {
    const wait = newBarrier();
    barrier = { reached: wait.signal, gate: wait.gate };
    return wait;
  };
  const pauseBeforeFinalLock = () => {
    const wait = newBarrier();
    // The shared rate limiter uses the first PostgreSQL transaction.
    transactionBarrier = { reached: wait.signal, gate: wait.gate, skip: 1 };
    return wait;
  };
  const stagedDb = {
    ...db,
    postgresTransaction: async <T>(work: (client: PoolClient) => Promise<T>) =>
      db.postgresTransaction!(async (transactionClient) => {
        const waiting = transactionBarrier;
        if (waiting?.skip) waiting.skip--;
        else if (waiting) {
          transactionBarrier = null;
          waiting.reached();
          await waiting.gate;
        }
        return work(transactionClient);
      }),
  };
  const stagedArchive = {
    ...archive,
    db: stagedDb,
    meta: async () => {
      const result = await archive.meta();
      const waiting = barrier;
      barrier = null;
      if (waiting) {
        waiting.reached();
        await waiting.gate;
      }
      return result;
    },
  };
  const handler = offlinePackageHttp({
    archive: stagedArchive, auth, uploadsDirectory, streamDeadlineMs: 2_000,
  });
  let reachedStall: (() => void) | null = null;
  const server = createServer((req, res) => {
    if (req.headers["x-test-stall"] === "1")
      res.write = (() => { reachedStall?.(); return false; }) as typeof res.write;
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = (token: string) => fetch(base + "/api/offline/export", {
    headers: { Cookie: `drevo_session=${token}` },
  });
  const stalledRequest = (token: string, signal?: AbortSignal) => {
    const reached = new Promise<void>((resolve) => { reachedStall = resolve; });
    const response = fetch(base + "/api/offline/export", {
      headers: { Cookie: `drevo_session=${token}`, "X-Test-Stall": "1" },
      signal,
    }).then(async (result) => { await result.arrayBuffer(); return result; });
    void response.catch(() => {});
    return { reached, response };
  };
  const waitForBlockedQuery = async (fragment: string) => {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const blocked = await db.prepare("", `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
        WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE ?) AS blocked`).get(`%${fragment}%`);
      if (blocked?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Write did not wait for offline ZIP delivery: ${fragment}`);
  };
  const waitForCleanup = async (existing: Set<string>) => {
    const deadline = Date.now() + 2_000;
    while (true) {
      const extra = (await readdir(tmpdir())).filter((name) =>
        name.startsWith("drevo-offline-") && !existing.has(name));
      const task = await db.withExclusiveArchiveTask!("offline-export", async () => true);
      if (!extra.length && task.acquired) return;
      if (Date.now() >= deadline)
        throw new Error(`Offline export retained temporary ZIP or task lock: ${extra.join(",")}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    const revokedPause = pauseAfterFinalRead();
    const revokedRequest = request(revokedToken);
    await revokedPause.reached;
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedHash]);
    revokedPause.release();
    const revoked = await revokedRequest;
    const revokedType = revoked.headers.get("content-type");
    await revoked.arrayBuffer();

    const memberPause = pauseAfterFinalRead();
    const memberRequest = request(memberToken);
    await memberPause.reached;
    await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id=$2",
      [archiveId, accountId]);
    memberPause.release();
    const member = await memberRequest;
    const memberType = member.headers.get("content-type");
    await member.arrayBuffer();

    assert.deepEqual([revoked.status, member.status], [401, 409],
      "a completed session or membership revoke must stop offline ZIP delivery");
    assert.notEqual(revokedType, "application/zip");
    assert.notEqual(memberType, "application/zip");
    const racePause = pauseBeforeFinalLock();
    const raceRequest = request(raceToken);
    await racePause.reached;
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [raceHash]);
    racePause.release();
    const raced = await raceRequest;
    const racedBody = await raced.text();
    assert.equal(raced.status, 401,
      `a completed revoke after accountSession but before the row lock must fail closed: ${racedBody}`);
    assert.notEqual(raced.headers.get("content-type"), "application/zip");
    console.log("offline_export_delivery_revocation_verified");

    const existing = new Set((await readdir(tmpdir())).filter((name) =>
      name.startsWith("drevo-offline-")));
    const stalled = stalledRequest(stallToken);
    await stalled.reached;
    await client.query("BEGIN");
    try {
      const writableArchive = await client.query(
        "SELECT id FROM archives WHERE id=$1 FOR UPDATE NOWAIT", [archiveId]);
      assert.equal(writableArchive.rows[0]?.id, archiveId,
        "a stalled ZIP download must not block ordinary archive writes");
    } finally {
      await client.query("ROLLBACK");
    }
    const revokeDuringDelivery = client.query(
      "DELETE FROM account_sessions WHERE token_hash=$1", [stallHash]);
    await waitForBlockedQuery("DELETE FROM account_sessions WHERE token_hash");
    await assert.rejects(stalled.response,
      "a stalled ZIP transfer must end at its absolute stream deadline");
    await revokeDuringDelivery;
    await waitForCleanup(existing);
    const recovered = await request(recoveryToken);
    assert.equal(recovered.status, 200, "a timeout releases the archive for the next export");
    assert.equal(recovered.headers.get("content-type"), "application/zip");
    await recovered.arrayBuffer();

    const controller = new AbortController();
    const aborted = stalledRequest(recoveryToken, controller.signal);
    await aborted.reached;
    const revokeMembership = client.query(
      "UPDATE archive_memberships SET approved=false WHERE archive_id=$1 AND user_id=$2",
      [archiveId, stallAccountId]);
    await waitForBlockedQuery("UPDATE archive_memberships SET approved=false");
    controller.abort();
    await assert.rejects(aborted.response);
    await revokeMembership;
    await waitForCleanup(existing);
    console.log("offline_export_stream_cleanup_verified");
  } finally {
    for (const release of releases) release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.query("DELETE FROM account_sessions WHERE token_hash IN ($1,$2,$3,$4,$5)",
      [revokedHash, memberHash, raceHash, stallHash, recoveryHash]);
    await client.query("DELETE FROM archive_memberships WHERE archive_id=$1 AND user_id IN ($2,$3,$4)",
      [archiveId, accountId, raceAccountId, stallAccountId]);
    await client.query("DELETE FROM accounts WHERE id IN ($1,$2,$3)",
      [accountId, raceAccountId, stallAccountId]);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [previousContext || ""]);
  }
}
