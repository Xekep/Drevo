import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Client } from "pg";
import pg from "pg";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";

/** Account-scoped roles do not mint archive access or change an account tier. */
export async function verifyPlatformStaffRoles(
  client: Client,
  base: string,
  ownerHeaders: Record<string, string>,
  origin: string,
) {
  const id = `platform-role-${randomUUID()}`;
  const token = newSessionToken();
  const hash = sessionTokenHash(token);
  const targetHeaders = {
    Cookie: `drevo_session=${token}`,
    Origin: origin,
    "Content-Type": "application/json",
  };
  const roleUrl = `${base}/api/platform/roles/${encodeURIComponent(id)}`;
  const patch = (headers: Record<string, string>, role: "admin" | "researcher" | null) =>
    fetch(roleUrl, { method: "PATCH", headers, body: JSON.stringify({ role }) });
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Platform role fixture',$2)",
    [id, new Date().toISOString()]);
  await client.query(`INSERT INTO account_tiers(account_id,full_access) VALUES($1,false)
    ON CONFLICT(account_id) DO UPDATE SET full_access=false`, [id]);
  await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
    [hash, id, Date.now() + 600_000]);
  try {
    const beforeLocal = await client.query(`SELECT m.role,m.approved,m.person_id,m.tree_access,
      t.full_access FROM archive_memberships m
      JOIN account_tiers t ON t.account_id=m.user_id
      WHERE m.archive_id='runtime-test' AND m.user_id='reader'`);
    assert.equal(beforeLocal.rowCount, 1);
    for (const body of [
      { role: "admin" },
      { role: "researcher" },
      { approved: true, role: "admin" },
    ]) {
      const rejected = await fetch(`${base}/api/users/reader`, {
        method: "PATCH", headers: ownerHeaders, body: JSON.stringify(body),
      });
      assert.ok([400, 403].includes(rejected.status),
        `a tree owner cannot grant a global staff role through archive users: ${rejected.status}`);
      const afterLocal = await client.query(`SELECT m.role,m.approved,m.person_id,m.tree_access,
        t.full_access FROM archive_memberships m
        JOIN account_tiers t ON t.account_id=m.user_id
        WHERE m.archive_id='runtime-test' AND m.user_id='reader'`);
      assert.deepEqual(afterLocal.rows, beforeLocal.rows,
        "forbidden role input cannot partially apply approval, scope, identity, tier or role");
    }
    assert.equal((await fetch(`${base}/api/platform/roles`, { headers: ownerHeaders })).status, 200);
    assert.equal((await patch(ownerHeaders, "researcher")).status, 200);
    const profile = await fetch(`${base}/api/session`, { headers: targetHeaders });
    assert.equal(profile.status, 200);
    const session = await profile.json();
    assert.equal(session.account?.globalRole, "researcher");
    assert.equal(session.user, null, "a platform grant cannot fabricate archive membership");
    assert.equal((await fetch(`${base}/api/platform/roles`, { headers: targetHeaders })).status, 403);
    assert.ok([401, 403].includes(
      (await fetch(`${base}/api/family`, { headers: targetHeaders })).status));
    assert.equal((await patch(targetHeaders, "admin")).status, 403);

    // A received body can precede COMMIT of the protected GET delivery.
    // Wait for its target-account read lock before the next ordinary mutation.
    await client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [id]);
    assert.equal((await patch(ownerHeaders, "admin")).status, 200);
    const adminProfile = await fetch(`${base}/api/session`, { headers: targetHeaders }).then((r) => r.json());
    assert.equal(adminProfile.account?.globalRole, "admin");
    assert.equal(adminProfile.user, null);
    const roles = await fetch(`${base}/api/platform/roles`, { headers: targetHeaders });
    assert.equal(roles.status, 200);
    await roles.arrayBuffer();
    assert.ok([401, 403].includes(
      (await fetch(`${base}/api/family`, { headers: targetHeaders })).status));
    assert.equal((await fetch(`${base}/api/mcp/tokens`, { headers: targetHeaders })).status, 403,
      "a global admin without approved archive ownership cannot manage full-tree MCP tokens");

    await client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [id]);
    assert.equal((await patch(ownerHeaders, null)).status, 200);
    assert.equal((await fetch(`${base}/api/platform/roles`, { headers: targetHeaders })).status, 403);
    assert.equal((await patch(ownerHeaders, null)).status, 200,
      "an idempotent role request is accepted without new audit history");
    assert.equal((await patch(ownerHeaders, null)).status, 200);
    const targetState = await client.query<{ full_access: boolean; memberships: string; audit: string }>(
      `SELECT t.full_access,
        (SELECT count(*) FROM archive_memberships WHERE user_id=$1)::text AS memberships,
        (SELECT count(*) FROM platform_role_audit WHERE target_id=$1)::text AS audit
       FROM account_tiers t WHERE t.account_id=$1`, [id]);
    assert.deepEqual(targetState.rows[0], { full_access: false, memberships: "0", audit: "3" });
    const ownerId = "owner";
    const selfDemotion = await fetch(`${base}/api/platform/roles/${ownerId}`, {
      method: "PATCH", headers: ownerHeaders, body: JSON.stringify({ role: null }),
    });
    assert.equal(selfDemotion.status, 403, "the final platform administrator remains assigned");
    assert.equal((await client.query("SELECT count(*) AS n FROM platform_admins")).rows[0].n, "1");
    const issued = await fetch(`${base}/api/mcp/tokens`, {
      method: "POST", headers: ownerHeaders,
      body: JSON.stringify({ name: "Issuer revoke fixture", scopes: ["tree:read"] }),
    });
    assert.equal(issued.status, 201);
    const credential = await issued.json() as { item: { id: string }; token: string };
    const mcp = () => fetch(`${base}/mcp`, {
      method: "POST", headers: { Origin: origin,
        Authorization: `Bearer ${credential.token}`,
        "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    try {
      assert.equal((await mcp()).status, 200);
      await client.query("UPDATE archive_owners SET user_id='reader' WHERE archive_id='runtime-test'");
      try {
        const denied = await mcp();
        assert.equal(denied.status, 401);
        assert.doesNotMatch(await denied.text(), /person-a|structuredContent/);
      } finally {
        await client.query("UPDATE archive_owners SET user_id='owner' WHERE archive_id='runtime-test'");
      }
      await client.query("INSERT INTO platform_admins(account_id) VALUES($1)", [id]);
      await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
      try {
        const denied = await mcp();
        assert.equal(denied.status, 401);
        assert.doesNotMatch(await denied.text(), /person-a|structuredContent/);
      } finally {
        await client.query("INSERT INTO platform_admins(account_id) VALUES('owner')");
        await client.query("DELETE FROM platform_admins WHERE account_id=$1", [id]);
      }
      assert.equal((await mcp()).status, 200);
    } finally {
      const revoked = await fetch(`${base}/api/mcp/tokens/${credential.item.id}`,
        { method: "DELETE", headers: ownerHeaders });
      assert.equal(revoked.status, 200);
    }
    await verifyTierRevocationBarrier(client, base, origin);
    console.log("runtime_platform_staff_roles_isolation_ok");
  } finally {
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    await client.query("DELETE FROM platform_role_audit WHERE target_id=$1", [id]);
    await client.query("DELETE FROM platform_researchers WHERE account_id=$1", [id]);
    await client.query("DELETE FROM platform_admins WHERE account_id=$1", [id]);
    await client.query("DELETE FROM accounts WHERE id=$1", [id]);
  }
}

async function verifyTierRevocationBarrier(client: Client, base: string, origin: string) {
  const token = newSessionToken();
  const hash = sessionTokenHash(token);
  const before = (await client.query<{ full_access: boolean }>(
    "SELECT full_access FROM account_tiers WHERE account_id='reader'"))
    .rows[0].full_access;
  const blocker = new pg.Client();
  await blocker.connect();
  await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [hash, Date.now() + 600_000]);
  let transactionOpen = false;
  const blockerPid = (await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  const waitForBlocked = async (change: Promise<Response>) => {
    let completedStatus: number | undefined;
    void change.then((response) => { completedStatus = response.status; },
      () => { completedStatus = 0; });
    for (let attempt = 0; attempt < 250; attempt++) {
      const waiting = await blocker.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))) AS blocked`,
        [blockerPid]);
      if (waiting.rows[0].blocked) return;
      if (completedStatus !== undefined)
        throw new Error(`Tier mutation finished before its target lock: ${completedStatus}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Expected tier mutation to wait on its locked target account");
  };
  try {
    await blocker.query("BEGIN");
    transactionOpen = true;
    await blocker.query("SELECT full_access FROM account_tiers WHERE account_id='reader' FOR UPDATE");
    const headers = { Cookie: `drevo_session=${token}`, Origin: origin,
      "Content-Type": "application/json" };
    const change = fetch(`${base}/api/users/reader`, {
      method: "PATCH", headers, body: JSON.stringify({ fullAccess: !before }),
    });
    await waitForBlocked(change);
    const revoke = client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    const revokeCompleted = await Promise.race([
      revoke.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    assert.equal(revokeCompleted, false,
      "session revoke waits while the accepted tier mutation holds its final guard");
    await blocker.query("COMMIT");
    transactionOpen = false;
    assert.equal((await change).status, 200,
      "tier mutation finishes before a concurrent session revoke can commit");
    assert.equal((await revoke).rowCount, 1);
    const after = await fetch(`${base}/api/users/reader`, {
      method: "PATCH", headers, body: JSON.stringify({ fullAccess: before }),
    });
    assert.ok([401, 403].includes(after.status), "completed session revoke blocks another tier mutation");
  } finally {
    if (transactionOpen) await blocker.query("ROLLBACK");
    await blocker.end();
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    await client.query("UPDATE account_tiers SET full_access=$1 WHERE account_id='reader'", [before]);
  }
}
