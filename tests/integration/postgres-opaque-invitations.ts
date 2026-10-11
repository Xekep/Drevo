import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Client } from "pg";
import { accountInvitations, archiveInvitations, InvalidInvitationError } from "../../src/server/archive-invitations.ts";
import { userStore } from "../../src/server/users.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

/** Actual runtime credentials prove the bearer lookup never widens other RLS. */
export async function verifyOpaqueInvitations(db: StoreDatabase, client: Client) {
  const original = db.archiveId!;
  const target = "opaque-invitation-neighbor";
  const accounts = ["opaque-invite-first", "opaque-invite-second"];
  const sessions = accounts.map(() => randomBytes(32).toString("hex"));
  const invites: Array<{ id: string; token: string; hash: string }> = [];
  const acceptance = accountInvitations(db);
  let rootInviteId: string | undefined;
  try {
    for (const [index, account] of accounts.entries()) {
      await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,$1,now())", [account]);
      await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)", [sessions[index], account, Date.now() + 600_000]);
    }
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [target]);
    await client.query("INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version) VALUES($1,'Opaque target','',false,0,21)", [target]);
    await client.query("INSERT INTO people(archive_id,id,data) VALUES($1,'opaque-private-person','{}')", [target]);
    for (const state of ["active", "concurrent", "expired", "revoked", "used"]) {
      const token = randomBytes(32).toString("base64url");
      const value = { id: randomUUID(), token, hash: createHash("sha256").update(token).digest("hex") };
      invites.push(value);
      await client.query(`INSERT INTO archive_invitations
        (archive_id,id,token_hash,role,created_by,created_at,expires_at,revoked_at,used_by,used_at)
        VALUES($1,$2,$3,'reader','owner',$4,$5,$6,$7,$8)`,
      [target, value.id, value.hash, new Date().toISOString(),
        new Date(Date.now() + (state === "expired" ? -60_000 : 600_000)).toISOString(),
        state === "revoked" ? new Date().toISOString() : null,
        state === "used" ? accounts[0] : null, state === "used" ? new Date().toISOString() : null]);
    }
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [original]);
    const owner = (await (await userStore(db)).get("owner"))!;
    const rootInvite = await archiveInvitations(db).create(owner, "reader", 24);
    rootInviteId = rootInvite.id;
    assert.match(rootInvite.path, /^\/join\/[A-Za-z0-9_-]{43}$/);
    const rootToken = rootInvite.path.split("/").at(-1)!;
    let preview: unknown;
    await acceptance.deliverPreview(undefined, rootToken, async (value) => { preview = value; });
    assert.equal((preview as { archiveId: string }).archiveId, original);
    await db.postgresTransaction!(async (runtime) => {
      assert.equal((await runtime.query("SELECT id FROM archive_invitations WHERE archive_id=$1", [target])).rowCount, 0);
      await runtime.query("SELECT set_config('drevo.invitation_token_hash',$1,true)", [invites[0].hash]);
      assert.deepEqual((await runtime.query("SELECT id FROM archive_invitations WHERE archive_id=$1", [target])).rows, [{ id: invites[0].id }]);
      assert.equal((await runtime.query("SELECT id FROM people WHERE archive_id=$1", [target])).rowCount, 0);
      assert.equal((await runtime.query("SELECT user_id FROM archive_memberships WHERE archive_id=$1", [target])).rowCount, 0);
      assert.equal((await runtime.query("UPDATE archive_invitations SET revoked_at=now()::text WHERE archive_id=$1", [target])).rowCount, 0,
        "bearer SELECT policy must not authorize mutation outside archive scope");
      await runtime.query("SELECT set_config('drevo.invitation_token_hash','',true)");
      assert.equal((await runtime.query("SELECT id FROM archive_invitations WHERE archive_id=$1", [target])).rowCount, 0);
    });
    await acceptance.deliverPreview(undefined, invites[0].token, async (value) => { preview = value; });
    assert.deepEqual(preview, { archiveId: target, title: "Opaque target", role: "reader" });
    await acceptance.deliverPreview(target, invites[0].token, async (value) => { preview = value; });
    assert.equal((preview as { archiveId: string }).archiveId, target, "legacy explicit-archive lookup remains supported");
    await assert.rejects(acceptance.deliverPreview(original, invites[0].token, async () => {}), InvalidInvitationError);
    for (const invite of invites.slice(2))
      await assert.rejects(acceptance.deliverPreview(undefined, invite.token, async () => {
        assert.fail("invalid bearer leaked invitation details");
      }), InvalidInvitationError);
    await assert.rejects(acceptance.deliverPreview(undefined, "z".repeat(43), async () => {}), InvalidInvitationError);
    const accepted = await acceptance.accept(undefined, invites[0].token, accounts[0], sessions[0]);
    assert.deepEqual(accepted, { archiveId: target, path: `/a/${target}/tree` });
    assert.deepEqual(await acceptance.accept(undefined, invites[0].token, accounts[0], sessions[0]), accepted,
      "same account retry remains idempotent");
    await assert.rejects(acceptance.accept(undefined, invites[0].token, accounts[1], sessions[1]), InvalidInvitationError);
    const concurrent = await Promise.allSettled(accounts.map((account, index) => acceptance.accept(undefined, invites[1].token, account, sessions[index])));
    assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(concurrent.filter((result) => result.status === "rejected" && result.reason instanceof InvalidInvitationError).length, 1);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [original]);
    assert.equal((await client.query("SELECT user_id FROM archive_memberships WHERE archive_id=$1 AND user_id=ANY($2)", [original, accounts])).rowCount, 0);
    await db.postgresTransaction!(async (runtime) => {
      assert.equal((await runtime.query("SELECT current_setting('drevo.invitation_token_hash',true) AS value")).rows[0].value || "", "");
      assert.equal((await runtime.query("SELECT id FROM people WHERE archive_id=$1", [target])).rowCount, 0);
    });
  } finally {
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [target]);
    await client.query("DELETE FROM archives WHERE id=$1", [target]);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [original]);
    if (rootInviteId) await client.query("DELETE FROM archive_invitations WHERE id=$1", [rootInviteId]);
    await client.query("DELETE FROM accounts WHERE id=ANY($1)", [accounts]);
  }
}
