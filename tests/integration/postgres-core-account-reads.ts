import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { Client } from "pg";
import { createAuth } from "../../src/server/auth.ts";
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
  const deliveryToken = newSessionToken();
  const deliveryHash = sessionTokenHash(deliveryToken);
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
  await observer.connect();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let revoke: Promise<void> | undefined;
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
    const deadline = Date.now() + 3_000;
    let blocked = false;
    while (Date.now() < deadline) {
      await observer.query("SELECT pg_stat_clear_snapshot()");
      const waiting = await observer.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid()
          AND wait_event_type='Lock'
          AND query LIKE 'DELETE FROM account_sessions WHERE token_hash=%') AS blocked`,
      );
      if (waiting.rows[0]?.blocked) { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(blocked, true, "session revoke waits until the capacity response is handed off");
    assert.equal(revoked, false);
    resumeWrite();
    const response = await pending;
    assert.equal(response.status, 200);
    await response.text();
    await revoke;
    assert.equal(revoked, true);
  } finally {
    resumeWrite();
    await revoke?.catch(() => {});
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await observer.end();
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [deliveryHash]);
  }
  console.log("core_account_get_revocation_verified");
}
