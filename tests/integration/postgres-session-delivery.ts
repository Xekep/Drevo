import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Client } from "pg";
import { createAuth } from "../../src/server/auth.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import { sessionHttp } from "../../src/server/session-http.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifySessionDelivery(db: StoreDatabase, client: Client) {
  const origin = "https://session-delivery.invalid";
  const revokedToken = newSessionToken();
  const heldToken = newSessionToken();
  const revokedHash = sessionTokenHash(revokedToken);
  const heldHash = sessionTokenHash(heldToken);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'reader',$3),($2,'reader',$3)",
    [revokedHash, heldHash, Date.now() + 600_000],
  );
  const auth = await createAuth(await userStore(db), db, origin);
  let reachedCheck!: () => void;
  let resumeCheck!: () => void;
  const checkReached = new Promise<void>((resolve) => { reachedCheck = resolve; });
  const checkGate = new Promise<void>((resolve) => { resumeCheck = resolve; });
  let reachedEnd!: () => void;
  let resumeEnd!: () => void;
  const endReached = new Promise<void>((resolve) => { reachedEnd = resolve; });
  const endGate = new Promise<void>((resolve) => { resumeEnd = resolve; });
  const handler = sessionHttp(auth, db,
    { yandex: true, vk: async () => false, email: false },
    async () => { reachedCheck(); await checkGate; });
  const server = createServer((req, res) => {
    if (req.headers["x-test-held"] === "1") {
      const end = res.end.bind(res);
      res.end = ((...args: Parameters<typeof res.end>) => {
        reachedEnd();
        void endGate.then(() => end(...args));
        return res;
      }) as typeof res.end;
    }
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const status = (token: string, hold = false) => fetch(base + "/api/session",
    { headers: { Cookie: `drevo_session=${token}`, ...(hold ? { "X-Test-Held": "1" } : {}) } });
  try {
    const stale = status(revokedToken);
    await checkReached;
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedHash]);
    resumeCheck();
    const staleResponse = await stale;
    assert.equal(staleResponse.status, 200);
    const staleBody = await staleResponse.json();
    assert.equal(staleBody.user, null);
    assert.equal(staleBody.account, null);
    assert.equal(staleBody.canEdit, false);
    console.log("runtime_session_revoke_before_delivery_ok");

    const parallel = await Promise.all(Array.from({ length: 12 }, () => status(heldToken)));
    for (const response of parallel) {
      assert.equal(response.status, 200);
      assert.equal((await response.json()).user.id, "reader");
    }
    console.log("runtime_parallel_session_delivery_ok");

    const held = status(heldToken, true);
    await endReached;
    const revoke = client.query("DELETE FROM account_sessions WHERE token_hash=$1", [heldHash]);
    assert.equal(await Promise.race([
      revoke.then(() => "completed"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]), "waiting", "logout must wait while the private session response is delivered");
    resumeEnd();
    const heldResponse = await held;
    assert.equal(heldResponse.status, 200);
    assert.equal((await heldResponse.json()).user.id, "reader");
    await revoke;
    assert.equal((await status(heldToken).then((response) => response.json())).user, null);
    console.log("runtime_session_revoke_after_delivery_ok");
  } finally {
    resumeCheck();
    resumeEnd();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.query("DELETE FROM account_sessions WHERE token_hash IN ($1,$2)",
      [revokedHash, heldHash]);
  }
}
