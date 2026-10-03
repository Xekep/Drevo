import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { Client } from "pg";
import { createAuth } from "../../src/server/auth.ts";
import { accountCapacity } from "../../src/server/account-capacity.ts";
import { coreHttp } from "../../src/server/core-http.ts";
import type { openArchive } from "../../src/server/database.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyCoreAccountGetRevocation(
  archive: Awaited<ReturnType<typeof openArchive>>,
  client: Client,
) {
  const origin = "https://core-account-read-revocation.invalid";
  const auth = await createAuth(await userStore(archive.db), archive.db, origin);
  const results: Array<{ path: string; status: number; body: string }> = [];
  for (const path of ["/api/account/sessions", "/api/account/capacity"]) {
    const activeToken = newSessionToken();
    const revokedToken = newSessionToken();
    const revokedHash = sessionTokenHash(revokedToken);
    for (const token of [activeToken, revokedToken])
      await client.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
        [sessionTokenHash(token), Date.now() + 600_000],
      );
    let reachedAuth!: () => void;
    let resumeAuth!: () => void;
    const authReached = new Promise<void>((resolve) => { reachedAuth = resolve; });
    const authGate = new Promise<void>((resolve) => { resumeAuth = resolve; });
    const delayedAuth = {
      ...auth,
      currentUser: async (req: IncomingMessage) => {
        const user = await auth.currentUser(req);
        if (user?.id === "owner" && req.headers.cookie?.includes(revokedToken)) {
          reachedAuth();
          await authGate;
        }
        return user;
      },
      sessionSummary: async (req: IncomingMessage) => {
        const summary = await auth.sessionSummary(req);
        if (summary && req.headers.cookie?.includes(revokedToken)) {
          reachedAuth();
          await authGate;
        }
        return summary;
      },
    };
    const handler = coreHttp({ archive, auth: delayedAuth, publicOrigin: origin });
    const server = createServer((req, res) => {
      void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const active = await fetch(base + path, {
        headers: { Cookie: `drevo_session=${activeToken}` },
      });
      assert.equal(active.status, 200, `${path}: active account read`);
      const activeBody = await active.text();
      assert.match(activeBody, path.endsWith("capacity") ? /"people"/ : /"items"/);
      const stale = fetch(base + path, {
        headers: { Cookie: `drevo_session=${revokedToken}` },
      });
      let timeout: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        authReached,
        stale.then(() => { throw new Error(`${path} completed before the auth barrier`); }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`${path} missed the auth barrier`)), 10_000);
          timeout.unref();
        }),
      ]).finally(() => { if (timeout) clearTimeout(timeout); });
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedHash]);
      resumeAuth();
      const response = await stale;
      results.push({ path, status: response.status, body: await response.text() });
    } finally {
      resumeAuth();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await client.query("DELETE FROM account_sessions WHERE token_hash=ANY($1)",
        [[sessionTokenHash(activeToken), revokedHash]]);
    }
  }
  assert.deepEqual(results.map(({ status }) => status), [401, 401],
    "a revoked session cannot receive its session inventory or archive capacity");
  for (const { body } of results)
    assert.doesNotMatch(body, /"items"|"currentExpiresAt"|"people"|"mediaBytes"/);
  const archiveId = archive.db.archiveId;
  assert.ok(archiveId, "capacity is scoped to one PostgreSQL archive");
  const transferToken = newSessionToken();
  const controlToken = newSessionToken();
  const transferHash = sessionTokenHash(transferToken);
  for (const token of [transferToken, controlToken])
    await client.query(
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
      [sessionTokenHash(token), Date.now() + 600_000],
    );
  let reachedSession!: () => void;
  let resumeSession!: () => void;
  const sessionReached = new Promise<void>((resolve) => { reachedSession = resolve; });
  const sessionGate = new Promise<void>((resolve) => { resumeSession = resolve; });
  const transferAuth = {
    ...auth,
    accountSession: async (req: IncomingMessage) => {
      const session = await auth.accountSession(req);
      if (session && req.headers.cookie?.includes(transferToken)) {
        reachedSession();
        await sessionGate;
      }
      return session;
    },
  };
  const transferHandler = coreHttp({ archive, auth: transferAuth, publicOrigin: origin });
  const transferServer = createServer((req, res) => {
    void transferHandler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => transferServer.listen(0, "127.0.0.1", resolve));
  let transferred = false;
  try {
    const base = `http://127.0.0.1:${(transferServer.address() as { port: number }).port}`;
    const active = await fetch(base + "/api/account/capacity", {
      headers: { Cookie: `drevo_session=${controlToken}` },
    });
    assert.equal(active.status, 200);
    assert.equal((await active.json()).owned, true);
    const stale = fetch(base + "/api/account/capacity", {
      headers: { Cookie: `drevo_session=${transferToken}` },
    });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      sessionReached,
      stale.then(() => { throw new Error("Capacity response completed before the owner barrier"); }),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Capacity response missed owner barrier")), 10_000);
        timeout.unref();
      }),
    ]).finally(() => { if (timeout) clearTimeout(timeout); });
    const changed = await client.query(
      "UPDATE archive_owners SET user_id='reader' WHERE archive_id=$1 AND user_id='owner'",
      [archiveId],
    );
    assert.equal(changed.rowCount, 1);
    transferred = true;
    resumeSession();
    const response = await stale;
    assert.equal(response.status, 409,
      "a completed owner transfer must withhold prepared capacity counts");
    assert.doesNotMatch(await response.text(), /"people"|"mediaBytes"|"owned":true/);
  } finally {
    resumeSession();
    transferServer.closeAllConnections();
    await new Promise<void>((resolve) => transferServer.close(() => resolve()));
    if (transferred)
      await client.query(
        "UPDATE archive_owners SET user_id='owner' WHERE archive_id=$1 AND user_id='reader'",
        [archiveId],
      );
    await client.query("DELETE FROM account_sessions WHERE token_hash=ANY($1)",
      [[transferHash, sessionTokenHash(controlToken)]]);
  }
  const deliveryToken = newSessionToken();
  const deliveryHash = sessionTokenHash(deliveryToken);
  const capacityBeforeDelivery = await accountCapacity(archive.db, "owner");
  assert.equal(capacityBeforeDelivery.available && capacityBeforeDelivery.owned, true,
    "the delayed capacity response contains owner-only counts");
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [deliveryHash, Date.now() + 600_000],
  );
  let reachedWrite!: () => void;
  let resumeWrite!: () => void;
  const writeReached = new Promise<void>((resolve) => { reachedWrite = resolve; });
  const writeGate = new Promise<void>((resolve) => { resumeWrite = resolve; });
  const handler = coreHttp({ archive, auth, publicOrigin: origin });
  const server = createServer((req, res) => {
    const end = res.end.bind(res);
    res.end = ((body?: string | Buffer) => {
      reachedWrite();
      void writeGate.then(() => end(body));
      return res;
    }) as typeof res.end;
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  const observer = new Client();
  const transferClient = new Client();
  await observer.connect();
  await transferClient.connect();
  await transferClient.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let revoke: Promise<void> | undefined;
  let transfer: Promise<void> | undefined;
  let transferredDuringDelivery = false;
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const pending = fetch(base + "/api/account/capacity", {
      headers: { Cookie: `drevo_session=${deliveryToken}` },
    });
    let writeTimeout: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      writeReached,
      pending.then(() => { throw new Error("Capacity response completed before the write barrier"); }),
      new Promise<never>((_, reject) => {
        writeTimeout = setTimeout(() => reject(new Error("Capacity response missed write barrier")), 5_000);
        writeTimeout.unref();
      }),
    ]).finally(() => { if (writeTimeout) clearTimeout(writeTimeout); });
    let revoked = false;
    revoke = client.query("DELETE FROM account_sessions WHERE token_hash=$1", [deliveryHash])
      .then(() => { revoked = true; });
    transfer = transferClient.query(
      "UPDATE archive_owners SET user_id='reader' WHERE archive_id=$1 AND user_id='owner'",
      [archiveId],
    ).then((result) => { transferredDuringDelivery = result.rowCount === 1; });
    const deadline = Date.now() + 3_000;
    let blockedRevoke = false;
    let blockedTransfer = false;
    while (Date.now() < deadline) {
      await observer.query("SELECT pg_stat_clear_snapshot()");
      const waiting = await observer.query<{ revoke: boolean; transfer: boolean }>(
        `SELECT
         EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid()
          AND wait_event_type='Lock'
          AND query LIKE 'DELETE FROM account_sessions WHERE token_hash=%') AS revoke,
         EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid()
          AND wait_event_type='Lock'
          AND query LIKE 'UPDATE archive_owners SET user_id=%') AS transfer`,
      );
      blockedRevoke ||= waiting.rows[0]?.revoke === true;
      blockedTransfer ||= waiting.rows[0]?.transfer === true;
      if (blockedRevoke && blockedTransfer) break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blockedRevoke, true, "session revoke waits until the capacity response is handed off");
    assert.equal(transferredDuringDelivery, false,
      "owner transfer must not complete before the capacity response is handed off");
    assert.equal(blockedTransfer, true, "owner transfer waits until the capacity response is handed off");
    assert.equal(revoked, false);
    resumeWrite();
    const response = await pending;
    assert.equal(response.status, 200);
    await response.text();
    await revoke;
    await transfer;
    assert.equal(revoked, true);
    assert.equal(transferredDuringDelivery, true);
  } finally {
    resumeWrite();
    await revoke?.catch(() => {});
    await transfer?.catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await observer.end();
    await transferClient.end();
    if (transferredDuringDelivery)
      await client.query(
        "UPDATE archive_owners SET user_id='owner' WHERE archive_id=$1 AND user_id='reader'",
        [archiveId],
      );
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [deliveryHash]);
  }
  console.log("core_account_get_revocation_verified");
}
