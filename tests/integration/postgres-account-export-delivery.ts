import assert from "node:assert/strict";
import { createServer } from "node:http";
import pg from "pg";
import { accountDataExportHttp } from "../../src/server/account-data-export-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyAccountExportDelivery(db: StoreDatabase) {
  const origin = "https://account-export-delivery.invalid";
  const token = newSessionToken();
  const hash = sessionTokenHash(token);
  const stalledToken = newSessionToken();
  const stalledHash = sessionTokenHash(stalledToken);
  const writer = new pg.Client();
  await writer.connect();
  await writer.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'reader',$3),($2,'reader',$3)",
    [hash, stalledHash, Date.now() + 60_000],
  );
  const auth = await createAuth(await userStore(db), db, origin);
  let reachedEnd!: () => void;
  let releaseEnd!: () => void;
  const endReached = new Promise<void>((resolve) => { reachedEnd = resolve; });
  const endGate = new Promise<void>((resolve) => { releaseEnd = resolve; });
  const endpoint = accountDataExportHttp(db, auth);
  const slowEndpoint = accountDataExportHttp(db, auth, undefined, 350);
  let reachedStall!: () => void;
  const stallReached = new Promise<void>((resolve) => { reachedStall = resolve; });
  const server = createServer((req, res) => {
    if (req.headers["x-test-hold"] === "1") {
      const originalEnd = res.end.bind(res);
      res.end = ((...args: Parameters<typeof res.end>) => {
        reachedEnd();
        void endGate.then(() => originalEnd(...args));
        return res;
      }) as typeof res.end;
    }
    if (req.headers["x-test-stall"] === "1")
      res.end = (() => { reachedStall(); return res; }) as typeof res.end;
    const handler = req.headers["x-test-stall"] === "1" ? slowEndpoint : endpoint;
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (hold = false) => fetch(`${base}/api/account/export`, {
    headers: { Cookie: `drevo_session=${token}`, ...(hold ? { "X-Test-Hold": "1" } : {}) },
  });
  const waitFor = async (signal: Promise<void>, message: string) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([signal, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 15_000);
        timer.unref();
      })]);
    } finally { clearTimeout(timer); }
  };
  try {
    const pending = get(true);
    void pending.catch(() => {});
    await waitFor(endReached, "Account export missed the delayed response barrier");
    const revocation = writer.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    const order = await Promise.race([
      revocation.then(() => "revoked"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    releaseEnd();
    const response = await pending;
    assert.equal(response.status, 200);
    assert.equal((await response.json()).account.id, "reader");
    assert.equal((await revocation).rowCount, 1);
    assert.equal(order, "waiting", "session revoke must wait until private JSON finishes sending");
    const revoked = await get();
    assert.equal(revoked.status, 401);
    assert.doesNotMatch(await revoked.text(), /"archives"|"reader"/);
    const stalled = fetch(`${base}/api/account/export`, {
      headers: { Cookie: `drevo_session=${stalledToken}`, "X-Test-Stall": "1" },
    });
    void stalled.catch(() => {});
    await waitFor(stallReached, "Account export missed the stalled response barrier");
    await assert.rejects(stalled, "a stalled private export must close at its deadline");
    await writer.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    const lockDeadline = Date.now() + 2_000;
    while (true) {
      try {
        await writer.query("SELECT token_hash FROM account_sessions WHERE token_hash=$1 FOR UPDATE NOWAIT",
          [stalledHash]);
        await writer.query("SELECT id FROM archives WHERE id='runtime-test' FOR UPDATE NOWAIT");
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "55P03" || Date.now() >= lockDeadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    console.log("runtime_account_export_delivery_revocation_ok");
  } finally {
    releaseEnd();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writer.query("DELETE FROM account_sessions WHERE token_hash IN ($1,$2)", [hash, stalledHash]);
    await writer.end();
  }
}
