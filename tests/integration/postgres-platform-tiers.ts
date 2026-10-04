import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Client } from "pg";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { createAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import { platformTiersHttp } from "../../src/server/platform-tiers-http.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";

/** A platform administrator can manage an account tier without joining its tree. */
export async function verifyPlatformTiers(client: Client, db: StoreDatabase, base: string, origin: string,
  ownerHeaders?: Record<string, string>) {
  const adminId = `platform-tier-admin-${randomUUID()}`;
  const targetId = `platform-tier-target-${randomUUID()}`;
  const readerId = `platform-tier-reader-${randomUUID()}`;
  const ownedArchiveId = `platform-tier-owned-${randomUUID()}`;
  const pagePrefix = `platform-tier-page-${randomUUID()}`;
  const pageIds = Array.from({ length: 31 }, (_, index) =>
    `${pagePrefix}-${String(index).padStart(3,"0")}`);
  const token = newSessionToken();
  const readerToken = newSessionToken();
  const headers = { Cookie: `drevo_session=${token}`, Origin: origin,
    "Content-Type": "application/json" };
  await client.query(`INSERT INTO accounts(id,name) VALUES($1,'Tier administrator'),
    ($2,'New own-tree account'),($3,'Tier reader')`, [adminId,targetId,readerId]);
  await client.query(`INSERT INTO account_tiers(account_id) VALUES($1),($2),($3)`,
    [adminId,targetId,readerId]);
  await client.query(`INSERT INTO platform_admins(account_id) VALUES($1)`, [adminId]);
  await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
    VALUES($1,$2,$3)`, [sessionTokenHash(token),adminId,Date.now() + 600_000]);
  await client.query(`INSERT INTO account_sessions(token_hash,user_id,expires_at)
    VALUES($1,$2,$3)`, [sessionTokenHash(readerToken),readerId,Date.now() + 600_000]);
  const endpoint = `${base}/api/platform/tiers/${encodeURIComponent(targetId)}`;
  const tierAuditIds: string[] = [];
  const change = (withHeaders: Record<string, string>, expectedFullAccess: boolean,
    fullAccess: boolean) => fetch(endpoint, { method: "PATCH", headers: withHeaders,
      body: JSON.stringify({ expectedFullAccess, fullAccess }) });
  try {
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM archive_memberships
      WHERE user_id IN ($1,$2,$3)`, [adminId,targetId,readerId])).rows[0].n, 0);
    const listed = await fetch(`${base}/api/platform/tiers`, { headers });
    assert.equal(listed.status, 200,
      "a platform administrator needs account-level tier access without archive membership");
    const initial = await listed.json() as { accounts: Array<{ id: string; fullAccess: boolean }>;
      totals: { basic: number; full: number } };
    assert.equal(initial.accounts.find((row) => row.id === targetId)?.fullAccess, false);
    assert.ok(initial.totals.basic >= 2);
    await client.query("BEGIN");
    try {
      await client.query("SELECT set_config('drevo.archive_id','runtime-test',true)");
      const lockedOwner = await client.query(`SELECT user_id FROM archive_owners
        WHERE archive_id='runtime-test' FOR UPDATE`);
      assert.equal(lockedOwner.rowCount, 1);
      const independentSession = await fetch(`${base}/api/session`, { headers });
      assert.equal(independentSession.status, 200,
        "a platform admin without membership does not wait on the tree owner row");
      const independentBody = await independentSession.json();
      assert.equal(independentBody.user, null);
      assert.equal(independentBody.account.id, adminId);
    } finally { await client.query("ROLLBACK"); }
    const initialDetail = await fetch(endpoint, { headers });
    assert.equal(initialDetail.status, 200);
    assert.deepEqual(await initialDetail.json(), { accountId: targetId, fullAccess: false },
      "a stale-tier refresh reads the current account level without archive membership");
    await client.query(`INSERT INTO accounts(id,name)
      SELECT id,'Synthetic page account' FROM unnest($1::text[]) AS id`, [pageIds]);
    await client.query(`INSERT INTO account_tiers(account_id)
      SELECT id FROM unnest($1::text[]) AS id`, [pageIds]);
    const firstPage = await fetch(`${base}/api/platform/tiers?after=${pagePrefix}`, { headers });
    assert.equal(firstPage.status, 200);
    const firstPageBody = await firstPage.json() as {
      accounts: Array<{ id: string }>; next: string | null };
    assert.deepEqual(firstPageBody.accounts.map((row) => row.id), pageIds.slice(0,30));
    assert.equal(firstPageBody.next, pageIds[29]);
    const secondPage = await fetch(`${base}/api/platform/tiers?after=${encodeURIComponent(pageIds[29])}`,
      { headers });
    assert.equal(secondPage.status, 200);
    assert.equal(((await secondPage.json()) as { accounts: Array<{ id: string }> }).accounts[0].id,
      pageIds[30], "keyset pagination does not drop the 31st account");
    const unused = await fetch(`${endpoint}/usage`, { headers });
    assert.equal(unused.status, 200);
    assert.deepEqual(await unused.json(), { accountId: targetId,
      owned: false, people: null, mediaBytes: null },
    "a new account without a tree has unknown usage, not a fabricated zero");
    const ownerUsage = await fetch(`${base}/api/platform/tiers/owner/usage`, { headers });
    assert.equal(ownerUsage.status, 200);
    const ownerBody = await ownerUsage.json() as { owned: boolean; people: number;
      mediaBytes: number | null };
    assert.equal(ownerBody.owned, true);
    assert.ok(ownerBody.people >= 1);
    assert.ok(ownerBody.mediaBytes === null || ownerBody.mediaBytes >= 0);
    assert.doesNotMatch(JSON.stringify(ownerBody), /person-a|runtime-test|\/media\//,
      "the quota response contains counts only, never archive IDs or media paths");
    assert.equal((await change({ ...headers, Cookie: `drevo_session=${readerToken}` },
      false, true)).status, 403, "an ordinary account cannot raise its own tier");
    await client.query("INSERT INTO platform_researchers(account_id) VALUES($1)", [readerId]);
    assert.equal((await change({ ...headers, Cookie: `drevo_session=${readerToken}` },
      false, true)).status, 403, "a platform researcher cannot set account tiers");
    assert.equal((await fetch(`${base}/api/platform/tiers`, {
      headers: { ...headers, Cookie: `drevo_session=${readerToken}` },
    })).status, 403);
    assert.equal((await fetch(`${base}/api/platform/tiers/owner/usage`, {
      headers: { ...headers, Cookie: `drevo_session=${readerToken}` },
    })).status, 403);
    if (ownerHeaders) {
      // Keep one administrator assigned while removing the owner's global
      // grant. Ownership itself must not authorize a platform-level tier.
      await client.query("DELETE FROM platform_admins WHERE account_id='owner'");
      try {
        assert.equal((await change(ownerHeaders, false, true)).status, 403);
        assert.equal((await fetch(`${base}/api/platform/tiers`,
          { headers: ownerHeaders })).status, 403);
      } finally {
        await client.query("INSERT INTO platform_admins(account_id) VALUES('owner')");
      }
      const originalOwnerTier = (await client.query<{ full_access: boolean }>(
        "SELECT full_access FROM account_tiers WHERE account_id='owner'"
      )).rows[0].full_access;
      try {
        await client.query("UPDATE account_tiers SET full_access=false WHERE account_id='owner'");
        const basicSession = await fetch(`${base}/api/session`, { headers: ownerHeaders });
        assert.equal(basicSession.status, 200);
        assert.equal((await basicSession.json()).user.aiAvailable, false,
          "a downgraded owner session closes AI without loading the family");
        await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='owner'");
        const fullSession = await fetch(`${base}/api/session`, { headers: ownerHeaders });
        assert.equal(fullSession.status, 200);
        assert.equal((await fullSession.json()).user.aiAvailable, true,
          "a restored owner tier reopens AI in the authoritative session response");
        const previousArchiveScope = (await client.query<{ archive_id: string }>(
          "SELECT current_setting('drevo.archive_id',true) AS archive_id"
        )).rows[0].archive_id || "";
        await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
        try {
          await client.query(`INSERT INTO archive_memberships
            (archive_id,user_id,role,approved,tree_access)
            VALUES('runtime-test',$1,'reader',true,'all')`, [readerId]);
          const invitedSession = async () => {
            const response = await fetch(`${base}/api/session`, {
              headers: { Cookie: `drevo_session=${readerToken}` },
            });
            assert.equal(response.status, 200);
            return response.json() as Promise<{ user: {
              aiAvailable: boolean; archiveOwner: boolean } | null }>;
          };
          await client.query("UPDATE account_tiers SET full_access=true WHERE account_id=$1",
            [readerId]);
          const invitedFull = await invitedSession();
          assert.equal(invitedFull.user?.archiveOwner, false);
          assert.equal(invitedFull.user?.aiAvailable, true,
            "a full invited reader may use AI when the actual archive owner is full");
          await client.query("UPDATE account_tiers SET full_access=false WHERE account_id=$1",
            [readerId]);
          assert.equal((await invitedSession()).user?.aiAvailable, false,
            "a basic invited viewer cannot use AI");
          await client.query("UPDATE account_tiers SET full_access=true WHERE account_id=$1",
            [readerId]);
          await client.query("UPDATE account_tiers SET full_access=false WHERE account_id='owner'");
          assert.equal((await invitedSession()).user?.aiAvailable, false,
            "the owner's basic tier closes AI for full invited viewers too");
          await client.query("UPDATE account_tiers SET full_access=true WHERE account_id='owner'");
          await client.query(`UPDATE archive_memberships SET approved=false
            WHERE archive_id='runtime-test' AND user_id=$1`, [readerId]);
          assert.equal((await invitedSession()).user?.aiAvailable, false,
            "an unapproved viewer cannot use AI");
        } finally {
          await client.query(`DELETE FROM archive_memberships
            WHERE archive_id='runtime-test' AND user_id=$1`, [readerId]);
          await client.query("UPDATE account_tiers SET full_access=false WHERE account_id=$1",
            [readerId]);
          await client.query("SELECT set_config('drevo.archive_id',$1,false)",
            [previousArchiveScope]);
        }
        const withoutMembership = await fetch(`${base}/api/session`, {
          headers: { Cookie: `drevo_session=${readerToken}` },
        });
        assert.equal(withoutMembership.status, 200);
        assert.equal((await withoutMembership.json()).user, null,
          "a global role and full tier never create archive membership");
      } finally {
        await client.query("UPDATE account_tiers SET full_access=$1 WHERE account_id='owner'",
          [originalOwnerTier]);
      }
    }
    const concurrent = await Promise.all([
      change(headers, false, true), change(headers, false, true),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 409],
      "two administrators cannot both commit from the same expected tier");
    assert.equal((await change(headers, false, false)).status, 409,
      "an obsolete admin view cannot overwrite the current tier");
    const changedDetail = await fetch(endpoint, { headers });
    assert.equal(changedDetail.status, 200);
    assert.deepEqual(await changedDetail.json(), { accountId: targetId, fullAccess: true });
    assert.equal((await change(headers, true, true)).status, 200,
      "an identical request is idempotent");
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM platform_config_audit
      WHERE item_id=$1 AND action='account_tier_enable_full'`, [targetId])).rows[0].n, 1);
    assert.equal((await change(headers, true, false)).status, 200);
    assert.equal((await client.query(`SELECT count(*)::int AS n FROM platform_config_audit
      WHERE item_id=$1 AND action IN
        ('account_tier_enable_full','account_tier_disable_full')`, [targetId])).rows[0].n, 2);
    tierAuditIds.push(...(await client.query<{ id: string }>(`SELECT id FROM platform_config_audit
      WHERE item_id=$1 AND action IN
        ('account_tier_enable_full','account_tier_disable_full')`, [targetId])).rows
      .map((row) => row.id));
    const unchanged = await client.query(`SELECT
      (SELECT count(*)::int FROM archive_memberships WHERE user_id=$1) AS memberships,
      (SELECT count(*)::int FROM archive_owners WHERE user_id=$1) AS owners,
      (SELECT count(*)::int FROM platform_admins WHERE account_id=$1) AS admins,
      (SELECT count(*)::int FROM platform_researchers WHERE account_id=$1) AS researchers,
      (SELECT full_access FROM account_tiers WHERE account_id=$1) AS full_access`, [targetId]);
    assert.deepEqual(unchanged.rows[0], { memberships: 0, owners: 0,
      admins: 0, researchers: 0, full_access: false });
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [ownedArchiveId]);
    try {
      await client.query(`INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version)
        VALUES($1,'Synthetic tier usage','',false,0,18)`, [ownedArchiveId]);
      await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
        VALUES($1,$2,'relative',true,'all')`, [ownedArchiveId,targetId]);
      await client.query(`INSERT INTO archive_owners(archive_id,user_id) VALUES($1,$2)`,
        [ownedArchiveId,targetId]);
      await client.query(`INSERT INTO people(id,data) VALUES('tier-visible-person',
        '{"id":"tier-visible-person","name":"Private synthetic person"}'::jsonb)`);
      await client.query(`INSERT INTO documents(archive_id,id,ordinal,title,title_search,
        file_name,file_size,uploaded_by,created_at)
        VALUES($1,'tier-counted-file',1,'Private synthetic file','private synthetic file',
          'tier-counted.pdf',20000000,$2,$3)`,
        [ownedArchiveId,targetId,new Date().toISOString()]);
    } finally {
      await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    }
    await client.query("SELECT set_config('drevo.account_id',$1,false)", [targetId]);
    const ownDirectory = await client.query(`SELECT archive_id FROM archive_owners WHERE user_id=$1`, [targetId]);
    await client.query("SELECT set_config('drevo.account_id','',false)");
    assert.equal(ownDirectory.rowCount, 1, "owner directory must expose only this account's archive");
    const used = await fetch(`${endpoint}/usage`, { headers });
    assert.equal(used.status, 200);
    assert.deepEqual(await used.json(), { accountId: targetId, owned: true,
      people: 1, mediaBytes: 20_000_000 },
      "usage counts only the target owner's own tree, including authoritative document bytes");
    await verifyTierReadExpiry(db, client, origin, headers, adminId, token);
    await verifyTierPostCommitRevocation(db, client, origin, headers,
      adminId, targetId);
    await verifyInFlightTierRevocation(db, client, origin, headers, adminId, endpoint);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [ownedArchiveId]);
    await client.query(`INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access)
      VALUES($1,$2,'reader',true,'all')`, [ownedArchiveId,readerId]);
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await verifyInFlightOwnerTransfer(db, client, origin, headers,
      ownedArchiveId, targetId, readerId);
    await client.query("DELETE FROM platform_admins WHERE account_id=$1", [adminId]);
    assert.equal((await change(headers, false, true)).status, 403,
      "completed global-grant revoke closes the next mutation");
    await client.query("INSERT INTO platform_admins(account_id) VALUES($1)", [adminId]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [sessionTokenHash(token)]);
    assert.equal((await change(headers, false, true)).status, 401,
      "completed logout closes the next mutation");
    console.log("runtime_platform_tiers_account_level_ok");
  } finally {
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [ownedArchiveId]);
    await client.query("DELETE FROM archives WHERE id=$1", [ownedArchiveId]);
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    await client.query(`DELETE FROM account_sessions WHERE user_id IN ($1,$2)`, [adminId,readerId]);
    await client.query(`DELETE FROM platform_config_audit
      WHERE id=ANY($1::bigint[]) OR item_id=$2 OR actor_id=$2`, [tierAuditIds,targetId]);
    await client.query("DELETE FROM accounts WHERE id=ANY($1::text[])", [pageIds]);
    await client.query(`DELETE FROM platform_admins WHERE account_id=$1`, [adminId]);
    await client.query(`DELETE FROM platform_researchers WHERE account_id=$1`, [readerId]);
    await client.query(`DELETE FROM accounts WHERE id IN ($1,$2,$3)`, [adminId,targetId,readerId]);
  }
}

async function serveTierWithHooks(db: StoreDatabase, origin: string,
  hooks: Parameters<typeof platformTiersHttp>[3]) {
  const endpoint = platformTiersHttp(db, await createAuth(await userStore(db), db, origin),
    origin, hooks);
  const server = createServer((req,res) => {
    void endpoint(req,res,new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0,"127.0.0.1",resolve));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
    close: async () => { server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve())); } };
}

async function waitForTierBarrier(reached: Promise<void>, request: Promise<Response>) {
  await Promise.race([reached,
    request.then(() => { throw new Error("Tier response preceded its test barrier"); }),
    new Promise<never>((_,reject) => setTimeout(() =>
      reject(new Error("Tier request did not reach its barrier")), 8_000))]);
}

async function verifyInFlightTierRevocation(db: StoreDatabase, client: Client,
  origin: string, headers: Record<string,string>, adminId: string, endpoint: string) {
  let reached!: () => void, release!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reached=resolve; });
  const gate = new Promise<void>((resolve) => { release=resolve; });
  const server = await serveTierWithHooks(db,origin,{ beforeAccessLock: async () => {
    reached(); await gate;
  } });
  const path = new URL(endpoint).pathname;
  const changing = fetch(server.base + path,{ method:"PATCH", headers,
    body: JSON.stringify({ expectedFullAccess:false, fullAccess:true }) });
  try {
    await waitForTierBarrier(atBarrier,changing);
    await client.query("DELETE FROM platform_admins WHERE account_id=$1",[adminId]);
    release();
    const response = await changing;
    assert.equal(response.status,403,
      "a completed platform grant revoke before final access lock denies tier mutation");
    assert.equal((await client.query("SELECT full_access FROM account_tiers WHERE account_id=$1",
      [decodeURIComponent(path.split("/").at(-1)!)] )).rows[0].full_access,false);
  } finally {
    release(); await changing.catch(() => {}); await server.close();
    await client.query("INSERT INTO platform_admins(account_id) VALUES($1) ON CONFLICT DO NOTHING",
      [adminId]);
  }
}

async function verifyInFlightOwnerTransfer(db: StoreDatabase, client: Client,
  origin: string, headers: Record<string,string>, archiveId: string,
  ownerId: string, nextOwnerId: string) {
  let reached!: () => void, release!: () => void;
  const atBarrier = new Promise<void>((resolve) => { reached=resolve; });
  const gate = new Promise<void>((resolve) => { release=resolve; });
  const server = await serveTierWithHooks(db,origin,{ beforeUsageOwnerLock: async () => {
    reached(); await gate;
  } });
  const reading = fetch(`${server.base}/api/platform/tiers/${encodeURIComponent(ownerId)}/usage`,
    { headers });
  try {
    await waitForTierBarrier(atBarrier,reading);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)",[archiveId]);
    await client.query("UPDATE archive_owners SET user_id=$2 WHERE archive_id=$1",
      [archiveId,nextOwnerId]);
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
    release();
    const response = await reading;
    assert.equal(response.status,409,
      "a transferred archive cannot be counted under its former owner");
    assert.doesNotMatch(await response.text(), /Private synthetic person|tier-counted.pdf|20000000/);
  } finally {
    release(); await reading.catch(() => {}); await server.close();
    await client.query("SELECT set_config('drevo.archive_id',$1,false)",[archiveId]);
    await client.query("UPDATE archive_owners SET user_id=$2 WHERE archive_id=$1",
      [archiveId,ownerId]);
    await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  }
}

async function verifyTierReadExpiry(db: StoreDatabase, client: Client,
  origin: string, headers: Record<string,string>, adminId: string, token: string) {
  let reached = false;
  const server = await serveTierWithHooks(db,origin,{ beforeReadDelivery: async (tx) => {
    reached = true;
    // Change the locked session in this transaction after the list is read.
    // Rollback restores the fixture; delivery must still recheck expiration.
    await tx.query(`UPDATE account_sessions SET expires_at=$1
      WHERE token_hash=$2 AND user_id=$3`,
    [Date.now() - 1, sessionTokenHash(token), adminId]);
  } });
  try {
    const response = await fetch(`${server.base}/api/platform/tiers`, { headers });
    assert.equal(reached, true, "the expiry was injected after the private list read");
    assert.equal(response.status, 403,
      "an expired session cannot receive a list prepared while it was active");
    assert.doesNotMatch(await response.text(), /New own-tree account|Tier administrator/);
    assert.equal((await client.query<{ expires_at: string }>(
      `SELECT expires_at FROM account_sessions WHERE token_hash=$1`,
      [sessionTokenHash(token)])).rowCount, 1,
    "the synthetic expiry rolls back with the denied read");
  } finally { await server.close(); }
}

async function verifyTierPostCommitRevocation(db: StoreDatabase, client: Client,
  origin: string, headers: Record<string,string>, adminId: string, targetId: string) {
  let committed = false;
  const priorAudit = new Set((await client.query<{ id: string }>(
    `SELECT id FROM platform_config_audit
     WHERE item_id=$1 AND action='account_tier_enable_full'`, [targetId]))
    .rows.map((row) => row.id));
  const server = await serveTierWithHooks(db,origin,{ afterMutationCommit: async () => {
    committed = true;
    await client.query("DELETE FROM platform_admins WHERE account_id=$1", [adminId]);
  } });
  let auditId: string | null = null;
  try {
    const response = await fetch(`${server.base}/api/platform/tiers/${encodeURIComponent(targetId)}`,
      { method: "PATCH", headers,
        body: JSON.stringify({ expectedFullAccess: false, fullAccess: true }) });
    assert.equal(committed, true, "the global grant was revoked after the tier write committed");
    assert.equal(response.status, 403,
      "a completed global revoke after commit withholds the private mutation ACK");
    assert.doesNotMatch(await response.text(), /fullAccess|changed/);
    assert.equal((await client.query<{ full_access: boolean }>(
      "SELECT full_access FROM account_tiers WHERE account_id=$1", [targetId]))
      .rows[0].full_access, true,
    "delivery denial does not roll back a tier mutation that already committed");
    const audit = await client.query<{ id: string }>(`SELECT id FROM platform_config_audit
      WHERE item_id=$1 AND action='account_tier_enable_full'`, [targetId]);
    const added = audit.rows.filter((row) => !priorAudit.has(row.id));
    assert.equal(added.length, 1, "a committed tier mutation adds exactly one audit event");
    auditId = added[0].id;
  } finally {
    await server.close();
    await client.query("INSERT INTO platform_admins(account_id) VALUES($1) ON CONFLICT DO NOTHING",
      [adminId]);
    await client.query("UPDATE account_tiers SET full_access=false WHERE account_id=$1", [targetId]);
    if (auditId) await client.query("DELETE FROM platform_config_audit WHERE id=$1", [auditId]);
  }
}
