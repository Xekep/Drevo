import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Client } from "pg";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { platformAiProviderCleanupHttp } from "../../src/server/platform-ai-provider-cleanup-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";

export async function verifyPlatformAiCleanup(
  db: StoreDatabase, client: Client, base: string, origin: string,
) {
  const accountId = `platform-cleanup-${randomUUID()}`;
  const session = newSessionToken(), sessionHash = sessionTokenHash(session);
  const jobId = randomUUID(), unsafeId = randomUUID(), deliveryId = randomUUID();
  const headers = { Cookie: `drevo_session=${session}`, Origin: origin,
    "Content-Type": "application/json" };
  const path = "/api/platform/ai/cleanup";
  const post = (id: string, extra: Record<string,string> = {}) => fetch(
    `${base}${path}/${id}/retry`, { method: "POST", headers: { ...headers,...extra }, body: "{}" });
  const job = (id: string) => client.query(`SELECT state,available_at,attempts,key_version,
    encrypted_snapshot,archive_id,local_chat_id,last_error FROM platform_ai_conversations
    WHERE id=$1`, [id]).then((result) => result.rows[0]);
  const audit = () => client.query(`SELECT actor_id,action,item_id FROM platform_config_audit
    WHERE actor_id=$1 AND action='ai_provider_cleanup_retry' ORDER BY id`, [accountId]);
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Synthetic platform operator',now())", [accountId]);
  try {
    await client.query("INSERT INTO account_tiers(account_id,full_access) VALUES($1,true)", [accountId]);
    await client.query("INSERT INTO platform_admins(account_id) VALUES($1)", [accountId]);
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [sessionHash,accountId,Date.now()+600_000]);
    for (const [id,reason] of [[jobId,"provider_auth_403"],[unsafeId,"snapshot_invalid"],
      [deliveryId,"provider_rejected_422"]])
      await client.query(`INSERT INTO platform_ai_conversations
        (id,key_version,encrypted_snapshot,archive_id,local_chat_id,state,available_at,
         lease_token,lease_until,attempts,last_error,created_at,updated_at)
        VALUES($1,1,'private-ciphertext-marker','private-archive-marker',
          'private-chat-marker','blocked',0,NULL,NULL,3,$2,$3,$3)`,
        [id,reason,Date.now()]);

    const noMember = await client.query(`SELECT 1 FROM archive_memberships WHERE user_id=$1`, [accountId]);
    assert.equal(noMember.rowCount,0,"the platform admin has no tree membership");
    const listing = await fetch(base + path,{ headers });
    assert.equal(listing.status,200,"root platform entry does not require tree membership");
    assert.equal(listing.headers.get("cache-control"),"private, no-store");
    const text = await listing.text();
    assert.doesNotMatch(text,/private-|encrypted_snapshot|local_chat_id|archive_id|lease_token|last_error/);
    assert.ok(JSON.parse(text).jobs.some((item: { id: string }) => item.id === jobId));
    assert.equal((await fetch(base + "/api/admin/ai/cleanup",{ headers })).status,401,
      "the old archive-scoped entry remains membership-gated");
    assert.equal((await fetch(base + path)).status,401);
    assert.equal((await post(jobId,{ Origin: "https://evil.test" })).status,403);
    assert.equal((await post(unsafeId)).status,409,"snapshot_invalid cannot be retried");
    const original = await job(jobId);
    assert.equal((await audit()).rowCount,0);
    const response = await post(jobId);
    assert.equal(response.status,202,"a queued acknowledgment follows the committed write");
    const queued = await response.json() as { nextAttemptAt: number };
    const after = await job(jobId);
    assert.equal(after.state,"pending");
    assert.equal(Number(after.available_at),queued.nextAttemptAt);
    for (const key of ["attempts","key_version","encrypted_snapshot","archive_id","local_chat_id"])
      assert.equal(after[key],original[key],key);
    assert.deepEqual((await audit()).rows,[{ actor_id: accountId,
      action: "ai_provider_cleanup_retry", item_id: jobId }]);
    assert.equal((await post(jobId)).status,409);
    assert.equal(Number((await job(jobId)).available_at),queued.nextAttemptAt);
    assert.equal((await audit()).rowCount,1);
    const archiveAudit = await client.query(`SELECT 1 FROM archive_audit_entries
      WHERE actor_id=$1 AND action='Повтор очистки поставлен в очередь'`, [accountId]);
    assert.equal(archiveAudit.rowCount,0,"platform action is not attributed to an archive");

    const auth = await createAuth(await userStore(db),db,origin);
    let statusReady!: () => void, releaseStatus!: () => void;
    const statusEntered = new Promise<void>((resolve) => { statusReady = resolve; });
    const statusGate = new Promise<void>((resolve) => { releaseStatus = resolve; });
    const statusHandler = platformAiProviderCleanupHttp({ auth,db,
      providerCleanup: { assertReady: async () => {} }, publicOrigin: origin,
      beforeRetryDelivery: async () => { statusReady(); await statusGate; } });
    const statusServer = createServer((req,res) => {
      void statusHandler(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => statusServer.listen(0,"127.0.0.1",resolve));
    const statusBase = `http://127.0.0.1:${(statusServer.address() as { port: number }).port}`;
    try {
      const pending = fetch(`${statusBase}${path}/${jobId}/retry`,
        { method: "POST", headers, body: "{}" });
      await statusEntered;
      await client.query("DELETE FROM platform_admins WHERE account_id=$1",[accountId]);
      releaseStatus();
      const denied = await pending;
      assert.equal(denied.status,403,"revoked access hides even a duplicate job's 409 status");
      assert.equal((await audit()).rowCount,1);
      assert.equal(Number((await job(jobId)).available_at),queued.nextAttemptAt);
    } finally {
      releaseStatus();
      await new Promise<void>((resolve) => statusServer.close(() => resolve()));
      await client.query("INSERT INTO platform_admins(account_id) VALUES($1) ON CONFLICT DO NOTHING",[accountId]);
    }

    let issued!: () => void, releaseIssue!: () => void;
    const issueReady = new Promise<void>((resolve) => { issued = resolve; });
    const issueGate = new Promise<void>((resolve) => { releaseIssue = resolve; });
    const deliveryHandler = platformAiProviderCleanupHttp({ auth,db,
      providerCleanup: { assertReady: async () => {} }, publicOrigin: origin,
      beforeRetryDelivery: async () => { issued(); await issueGate; } });
    const deliveryServer = createServer((req,res) => {
      void deliveryHandler(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => deliveryServer.listen(0,"127.0.0.1",resolve));
    const deliveryBase = `http://127.0.0.1:${(deliveryServer.address() as { port: number }).port}`;
    try {
      const pending = fetch(`${deliveryBase}${path}/${deliveryId}/retry`,
        { method: "POST", headers, body: "{}" });
      await issueReady;
      assert.equal((await job(deliveryId)).state,"pending",
        "the queue update commits before any 202 acknowledgment");
      assert.equal((await audit()).rowCount,2);
      await client.query("DELETE FROM platform_admins WHERE account_id=$1",[accountId]);
      releaseIssue();
      const denied = await pending;
      assert.equal(denied.status,403,"a revoked global grant cannot receive the queued acknowledgment");
      assert.equal((await job(deliveryId)).state,"pending",
        "the committed queue update is not falsely rolled back by delivery denial");
      assert.equal((await audit()).rowCount,2,"delivery denial does not duplicate the audit");
    } finally {
      releaseIssue();
      await new Promise<void>((resolve) => deliveryServer.close(() => resolve()));
      await client.query("INSERT INTO platform_admins(account_id) VALUES($1) ON CONFLICT DO NOTHING",[accountId]);
    }

    await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
      VALUES($1,$2,'reader',false,'all')`, [db.archiveId,accountId]);
    assert.equal((await fetch(base+path,{ headers })).status,200,
      "an unapproved local membership does not change a global platform grant");
    await client.query("DELETE FROM platform_admins WHERE account_id=$1",[accountId]);
    assert.equal((await fetch(base+path,{ headers })).status,403,
      "full tier and tree membership cannot replace the global grant");
    await client.query("INSERT INTO platform_researchers(account_id) VALUES($1)",[accountId]);
    assert.equal((await fetch(base+path,{ headers })).status,403,
      "global researcher cannot operate provider cleanup");
    await client.query("DELETE FROM platform_researchers WHERE account_id=$1",[accountId]);
    await client.query("INSERT INTO platform_admins(account_id) VALUES($1)",[accountId]);

    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const handler = platformAiProviderCleanupHttp({ auth,db,
      providerCleanup: { assertReady: async () => {} }, publicOrigin: origin,
      beforeAccessLock: async () => { entered(); await gate; } });
    const server = createServer((req,res) => {
      void handler(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
    const direct = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const pending = fetch(direct+path,{ headers });
      await ready;
      await client.query("DELETE FROM account_sessions WHERE token_hash=$1",[sessionHash]);
      release();
      const denied = await pending;
      assert.equal(denied.status,403);
      assert.equal("jobs" in await denied.json(),false,
        "logout before final lock cannot expose the platform queue");
    } finally {
      release();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
      [sessionHash,accountId,Date.now()+600_000]);
    let grantEntered!: () => void, releaseGrant!: () => void;
    const grantReady = new Promise<void>((resolve) => { grantEntered = resolve; });
    const grantGate = new Promise<void>((resolve) => { releaseGrant = resolve; });
    const grantHandler = platformAiProviderCleanupHttp({ auth,db,
      providerCleanup: { assertReady: async () => {} }, publicOrigin: origin,
      beforeAccessLock: async () => { grantEntered(); await grantGate; } });
    const grantServer = createServer((req,res) => {
      void grantHandler(req,res,new URL(req.url || "/",`http://${req.headers.host}`))
        .catch((error) => res.destroy(error));
    });
    await new Promise<void>((resolve) => grantServer.listen(0,"127.0.0.1",resolve));
    const grantBase = `http://127.0.0.1:${(grantServer.address() as { port: number }).port}`;
    try {
      const pending = fetch(grantBase+path,{ headers });
      await grantReady;
      await client.query("DELETE FROM platform_admins WHERE account_id=$1",[accountId]);
      releaseGrant();
      const denied = await pending;
      assert.equal(denied.status,403);
      assert.equal("jobs" in await denied.json(),false,
        "global grant revoked before final lock cannot expose the platform queue");
    } finally {
      releaseGrant();
      await new Promise<void>((resolve) => grantServer.close(() => resolve()));
    }
    console.log("runtime_platform_ai_cleanup_no_membership_revocation_audit_ok");
  } finally {
    await client.query("DELETE FROM platform_config_audit WHERE actor_id=$1",[accountId]);
    await client.query("DELETE FROM platform_ai_conversations WHERE id=ANY($1)",[[jobId,unsafeId,deliveryId]]);
    await client.query("DELETE FROM archive_memberships WHERE user_id=$1",[accountId]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1",[sessionHash]);
    await client.query("DELETE FROM platform_admins WHERE account_id=$1",[accountId]);
    await client.query("DELETE FROM platform_researchers WHERE account_id=$1",[accountId]);
    await client.query("DELETE FROM account_tiers WHERE account_id=$1",[accountId]);
    await client.query("DELETE FROM accounts WHERE id=$1",[accountId]);
  }
}
