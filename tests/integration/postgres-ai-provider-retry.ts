import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { aiProviderCleanupHttp } from "../../src/server/ai-provider-cleanup-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyAiProviderCleanupRetry(
  db: StoreDatabase,
  readerHeaders: Record<string, string>,
) {
  const previousGrant = await db.prepare("", "SELECT account_id FROM platform_admins WHERE account_id='owner'").get();
  const previousMembership = await db.prepare("", `SELECT approved FROM archive_memberships
    WHERE archive_id=? AND user_id='owner'`).get(db.archiveId!);
  if (!previousGrant)
    await db.prepare("", "INSERT INTO platform_admins(account_id) VALUES('owner')").run();
  const token = newSessionToken(), tokenHash = sessionTokenHash(token);
  const session = () => db.prepare("", `INSERT INTO account_sessions(token_hash,user_id,expires_at)
    VALUES(?,'owner',?) ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at`)
    .run(tokenHash, Date.now() + 600_000);
  await session();
  const auth = await createAuth(await userStore(db), db, "https://archive.test");
  let revoke: "none" | "session" | "membership" | "grant" = "none";
  let ready = true;
  let pauseAfterAccess = false;
  let expiryHookAt = 0, expiredAfterLock = false;
  let entered!: () => void, release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const held = new Promise<void>((resolve) => { release = resolve; });
  const handle = aiProviderCleanupHttp({
    auth, db, publicOrigin: "https://archive.test",
    providerCleanup: { assertReady: async () => { if (!ready) throw new Error("unavailable"); } },
    beforeAccessLock: async () => {
      if (revoke === "session")
        await db.prepare("", "DELETE FROM account_sessions WHERE token_hash=?").run(tokenHash);
      if (revoke === "membership")
        await db.prepare("", `UPDATE archive_memberships SET approved=false
          WHERE archive_id=? AND user_id='owner'`).run(db.archiveId!);
      if (revoke === "grant")
        await db.prepare("", "DELETE FROM platform_admins WHERE account_id='owner'").run();
    },
    afterAccessLock: async () => {
      if (expiryHookAt) {
        await new Promise((resolve) => setTimeout(resolve,
          Math.max(0, expiryHookAt - Date.now() + 20)));
        expiredAfterLock = true;
      }
      if (pauseAfterAccess) { entered(); await held; }
    },
  });
  const server = createServer((req, res) => {
    void handle(req, res, new URL(req.url!, "http://localhost")).catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Cookie: `drevo_session=${token}`, Origin: "https://archive.test",
    "Content-Type": "application/json" };
  const ids: string[] = [];
  const insert = async (reason: string) => {
    const id = randomUUID();
    ids.push(id);
    const now = Date.now();
    await db.prepare("", `INSERT INTO platform_ai_conversations
      (id,key_version,encrypted_snapshot,archive_id,local_chat_id,state,available_at,
       lease_token,lease_until,attempts,last_error,created_at,updated_at)
      VALUES(?,1,'private-ciphertext-marker','private-archive-marker',
        'private-chat-marker','blocked',0,NULL,NULL,3,?,?,?)`)
      .run(id, reason, now, now);
    return id;
  };
  const post = (id: string, overrides: RequestInit = {}) =>
    fetch(base + `/api/admin/ai/cleanup/${id}/retry`, {
      method: "POST", headers, body: "{}", ...overrides,
    });
  const row = (id: string) => db.prepare("", `SELECT state,available_at,attempts,
    encrypted_snapshot,key_version,archive_id,local_chat_id,last_error,lease_token,lease_until
    FROM platform_ai_conversations WHERE id=?`).get(id);
  const audit = () => db.prepare("", `SELECT actor_id,action,entity,entity_id,label,details
    FROM archive_audit_entries WHERE action='Повтор очистки поставлен в очередь'
    ORDER BY id`).all();
  try {
    const id = await insert("provider_auth_403");
    const before = await row(id), beforeAudit = (await audit()).length;
    assert.equal((await post(id, { headers: { "Content-Type": "application/json" } })).status, 401);
    assert.equal((await post(id, { headers: { ...readerHeaders,
      Origin: "https://archive.test", "Content-Type": "application/json" } })).status, 403);
    assert.equal((await post(id, { headers: { ...headers, Origin: "https://evil.test" } })).status, 403);
    assert.equal((await post(id, { headers: { ...headers, "Content-Type": "text/plain" } })).status, 415);
    assert.equal((await post(id, { body: "not-json" })).status, 400);
    assert.equal((await post("invalid-uuid")).status, 400);
    ready = false;
    assert.equal((await post(id)).status, 503);
    ready = true;
    for (const reason of ["snapshot_invalid", "provider_network", "provider_rejected_404",
      "provider_http_503", "unrecognized-private-error"]) {
      const unsafe = await insert(reason);
      assert.equal((await post(unsafe)).status, 409, reason);
      assert.equal((await row(unsafe))?.state, "blocked");
    }
    const staleLease = await insert("provider_auth_403");
    await db.prepare("", "UPDATE platform_ai_conversations SET lease_until=? WHERE id=?")
      .run(Date.now() + 60_000, staleLease);
    assert.equal((await post(staleLease)).status, 409,
      "a blocked row with an active lease cannot be queued");
    assert.deepEqual(await row(id), before);
    assert.equal((await audit()).length, beforeAudit);

    revoke = "session";
    assert.equal((await post(id)).status, 401);
    assert.equal((await row(id))?.state, "blocked");
    await session();
    revoke = "membership";
    assert.equal((await post(id)).status, 403);
    await db.prepare("", `UPDATE archive_memberships SET approved=true
      WHERE archive_id=? AND user_id='owner'`).run(db.archiveId!);
    revoke = "grant";
    assert.equal((await post(id)).status, 403);
    await db.prepare("", "INSERT INTO platform_admins(account_id) VALUES('owner') ON CONFLICT DO NOTHING").run();
    revoke = "none";
    assert.deepEqual(await row(id), before);
    assert.equal((await audit()).length, beforeAudit);

    const expiring = await insert("provider_auth_401");
    expiryHookAt = Date.now() + 3_000;
    await db.prepare("", "UPDATE account_sessions SET expires_at=? WHERE token_hash=?")
      .run(expiryHookAt, tokenHash);
    assert.equal((await post(expiring)).status, 401);
    assert.equal(expiredAfterLock, true,
      "the session expires after the final row lock but before the queue update");
    assert.equal((await row(expiring))?.state, "blocked");
    assert.equal((await audit()).length, beforeAudit);
    expiryHookAt = 0;
    await session();

    const first = await post(id);
    assert.equal(first.status, 202);
    const response = await first.json();
    assert.equal(response.queued, true);
    assert.ok(response.nextAttemptAt >= Date.now() + 43_000);
    const after = await row(id);
    assert.equal(after?.state, "pending");
    assert.equal(after?.available_at, response.nextAttemptAt);
    assert.equal(after?.last_error, null);
    for (const field of ["encrypted_snapshot", "key_version", "archive_id",
      "local_chat_id", "attempts"])
      assert.equal(after?.[field], before?.[field], field);
    const oneAudit = await audit();
    assert.equal(oneAudit.length, beforeAudit + 1);
    const recorded = oneAudit.at(-1)!;
    assert.equal(recorded.actor_id, "owner");
    assert.equal(recorded.entity, "ai_provider_cleanup");
    assert.equal(recorded.entity_id, "retry");
    assert.deepEqual(JSON.parse(String(recorded.details)), []);
    assert.doesNotMatch(JSON.stringify(recorded), /private-|ciphertext|provider_auth|provider_rejected/);
    const second = await post(id);
    assert.equal(second.status, 409);
    assert.equal((await row(id))?.available_at, response.nextAttemptAt);
    assert.equal((await audit()).length, beforeAudit + 1);

    const concurrent = await insert("provider_rejected_422");
    const results = await Promise.all([post(concurrent), post(concurrent)]);
    assert.deepEqual(results.map((item) => item.status).sort(), [202, 409]);
    assert.equal((await audit()).length, beforeAudit + 2);

    const locked = await insert("provider_auth_401");
    pauseAfterAccess = true;
    const delivery = post(locked);
    await reached;
    const revocation = db.prepare("", "DELETE FROM account_sessions WHERE token_hash=?").run(tokenHash);
    const raced = await Promise.race([
      revocation.then(() => "revoked"),
      new Promise<string>((resolve) => setTimeout(() => resolve("waiting"), 100)),
    ]);
    assert.equal(raced, "waiting", "revocation waits for the final authorization lock");
    pauseAfterAccess = false;
    release();
    assert.equal((await delivery).status, 202);
    await revocation;
    assert.equal((await post(locked)).status, 401);
    console.log("runtime_ai_provider_retry_permissions_cooldown_audit_ok");
  } finally {
    pauseAfterAccess = false;
    release();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.prepare("", "DELETE FROM account_sessions WHERE token_hash=?").run(tokenHash);
    await db.prepare("", `UPDATE archive_memberships SET approved=?::boolean
      WHERE archive_id=? AND user_id='owner'`).run(previousMembership?.approved === true ? "true" : "false",
      db.archiveId!);
    if (!previousGrant)
      await db.prepare("", "DELETE FROM platform_admins WHERE account_id='owner'").run();
    for (const id of ids)
      await db.prepare("", "DELETE FROM platform_ai_conversations WHERE id=?").run(id);
  }
}
