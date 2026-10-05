import assert from "node:assert/strict";
import type { Client } from "pg";
import {
  accountInvitations,
  archiveInvitations,
  InvalidInvitationError,
} from "../../src/server/archive-invitations.ts";
import { userStore, ForbiddenError } from "../../src/server/users.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

/** Real RLS and acceptance transaction: membership is never an account deletion. */
export async function verifyInvitationScopeAndMembershipRemoval(
  db: StoreDatabase,
  client: Client,
) {
  const archiveId = db.archiveId!;
  const neighborId = "invitation-boundary-neighbor";
  const ids = [
    "invite-scope-reader",
    "invite-scope-second",
    "invite-scope-conflict",
  ];
  const people = [
    "invite-scope-anchor",
    "invite-scope-conflict-anchor",
    "invite-scope-deleted-anchor",
  ];
  const created: string[] = [];
  const users = await userStore(db);
  const owner = (await users.get("owner"))!;
  const invitations = archiveInvitations(db);
  const acceptance = accountInvitations(db);
  const sessionHashes = new Map<string, string>();
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [
    archiveId,
  ]);
  try {
    for (const id of ids) {
      await client.query(
        "INSERT INTO accounts(id,name,created_at) VALUES($1,$1,now())",
        [id],
      );
      const session = sessionTokenHash(newSessionToken());
      sessionHashes.set(id, session);
      await client.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
        [session, id, Date.now() + 600_000],
      );
    }
    for (const id of people)
      await client.query(
        "INSERT INTO people(archive_id,id,data) VALUES($1,$2,$3)",
        [
          archiveId,
          id,
          JSON.stringify({
            id,
            name: "Тест",
            surname: "Приглашений",
            sex: "u",
            birth: "",
            parents: [],
            spouses: [],
            sources: [],
            generation: 1,
            column: 0,
          }),
        ],
      );
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [
      neighborId,
    ]);
    await client.query(
      "INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version) VALUES($1,'Neighbor','',false,0,18)",
      [neighborId],
    );
    await client.query(
      "INSERT INTO people(archive_id,id,data) VALUES($1,'foreign-invite-anchor','{}')",
      [neighborId],
    );
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,$2,'relative',true,'all')",
      [neighborId, ids[0]],
    );
    await client.query(
      "INSERT INTO user_tree_preferences(archive_id,user_id,reverse_timeline,card_variant,color_scheme) VALUES($1,$2,1,'portrait','white')",
      [neighborId, ids[0]],
    );
    const neighborPrefs = (
      await client.query(
        "SELECT * FROM user_tree_preferences WHERE archive_id=$1 AND user_id=$2",
        [neighborId, ids[0]],
      )
    ).rows[0];
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [
      archiveId,
    ]);
    await assert.rejects(
      invitations.create(owner, "reader", 24, null, "common_ancestors"),
      InvalidInvitationError,
    );
    await assert.rejects(
      invitations.create(owner, "admin", 24),
      InvalidInvitationError,
    );
    await assert.rejects(
      invitations.create(owner, "reader", 24, "foreign-invite-anchor", "all"),
      InvalidInvitationError,
    );
    const create = async (
      person: string | null,
      scope: "all" | "common_ancestors",
    ) => {
      const invite = await invitations.create(
        owner,
        "reader",
        24,
        person,
        scope,
      );
      created.push(invite.id);
      return invite;
    };
    const accept = (invite: { path: string }, id = ids[0]) =>
      acceptance.accept(
        archiveId,
        invite.path.split("/").at(-1)!,
        id,
        sessionHashes.get(id)!,
      );
    // Two pending bearers for one card: only one account may claim it.
    const blood = await create(people[0], "common_ancestors");
    const duplicate = await create(people[0], "all");
    assert.deepEqual(
      (await invitations.list(owner)).find((entry) => entry.id === blood.id)
        ?.treeAccess,
      "common_ancestors",
    );
    await accept(blood);
    const reader = (await users.get(ids[0]))!;
    assert.equal(reader.treeRole, "reader");
    assert.equal(reader.personId, people[0]);
    assert.equal(reader.treeAccess, "common_ancestors");
    assert.equal(reader.globalRole, null);
    await assert.rejects(accept(duplicate, ids[1]), InvalidInvitationError);
    assert.equal(
      (
        await client.query(
          "SELECT used_by FROM archive_invitations WHERE id=$1",
          [duplicate.id],
        )
      ).rows[0].used_by,
      null,
    );
    await assert.rejects(
      invitations.create(reader, "relative", 24),
      InvalidInvitationError,
    );
    // A broader bearer does not widen an already approved membership.
    const broader = await create(null, "all");
    await accept(broader);
    assert.equal((await users.get(ids[0]))!.treeAccess, "common_ancestors");
    assert.equal((await users.get(ids[0]))!.personId, people[0]);
    const concurrentA = await create(people[1], "common_ancestors");
    const concurrentB = await create(people[1], "common_ancestors");
    const claims = await Promise.allSettled([
      accept(concurrentA, ids[1]),
      accept(concurrentB, ids[2]),
    ]);
    assert.equal(
      claims.filter((claim) => claim.status === "fulfilled").length,
      1,
    );
    const deniedClaim = claims.find((claim) => claim.status === "rejected");
    assert.ok(
      deniedClaim?.status === "rejected" &&
        deniedClaim.reason instanceof InvalidInvitationError,
    );
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM archive_memberships WHERE person_id=$1",
          [people[1]],
        )
      ).rows[0].n,
      1,
    );
    await client.query("DELETE FROM archive_memberships WHERE person_id=$1", [
      people[1],
    ]);
    // Different existing identity must not be overwritten or consume bearer.
    const conflicting = await create(people[1], "common_ancestors");
    await client.query(
      "INSERT INTO archive_memberships(archive_id,user_id,role,approved,person_id,tree_access) VALUES($1,$2,'reader',true,$3,'all')",
      [archiveId, ids[2], people[2]],
    );
    await assert.rejects(accept(conflicting, ids[2]), InvalidInvitationError);
    assert.equal((await users.get(ids[2]))!.personId, people[2]);
    assert.equal(
      (
        await client.query(
          "SELECT used_by FROM archive_invitations WHERE id=$1",
          [conflicting.id],
        )
      ).rows[0].used_by,
      null,
    );
    // Anchor disappears between issue and use: never fall back to all.
    await client.query("DELETE FROM archive_memberships WHERE user_id=$1", [
      ids[2],
    ]);
    const deleted = await create(people[2], "common_ancestors");
    await client.query("DELETE FROM people WHERE id=$1", [people[2]]);
    await assert.rejects(accept(deleted, ids[1]), InvalidInvitationError);
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM archive_memberships WHERE user_id=$1",
          [ids[1]],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(users.remove(reader, "owner"), ForbiddenError);
    await client.query(
      "INSERT INTO user_tree_preferences(archive_id,user_id,reverse_timeline,card_variant,color_scheme) VALUES($1,$2,0,'portrait','warm')",
      [archiveId, ids[0]],
    );
    await client.query(
      "INSERT INTO platform_researchers(account_id) VALUES($1)",
      [ids[0]],
    );
    await users.remove(owner, ids[0]);
    assert.equal(await users.get(ids[0]), null);
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM user_tree_preferences WHERE user_id=$1",
          [ids[0]],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM platform_researchers WHERE account_id=$1",
          [ids[0]],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await client.query("SELECT 1 FROM accounts WHERE id=$1", [ids[0]]))
        .rowCount,
      1,
    );
    assert.equal(
      (
        await client.query(
          "SELECT 1 FROM account_sessions WHERE token_hash=$1",
          [sessionHashes.get(ids[0])],
        )
      ).rowCount,
      1,
    );
    assert.equal(
      (await client.query("SELECT 1 FROM people WHERE id=$1", [people[0]]))
        .rowCount,
      1,
    );
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [
      neighborId,
    ]);
    assert.equal(
      (
        await client.query(
          "SELECT role FROM archive_memberships WHERE user_id=$1",
          [ids[0]],
        )
      ).rows[0].role,
      "relative",
    );
    assert.deepEqual(
      (
        await client.query(
          "SELECT * FROM user_tree_preferences WHERE user_id=$1",
          [ids[0]],
        )
      ).rows[0],
      neighborPrefs,
    );
    console.log("invitation_scope_membership_removal_verified");
  } finally {
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [
      neighborId,
    ]);
    await client.query("DELETE FROM archives WHERE id=$1", [neighborId]);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [
      archiveId,
    ]);
    for (const id of created)
      await client.query("DELETE FROM archive_invitations WHERE id=$1", [id]);
    for (const id of ids)
      await client.query("DELETE FROM accounts WHERE id=$1", [id]);
    for (const id of people)
      await client.query("DELETE FROM people WHERE id=$1", [id]);
  }
}
