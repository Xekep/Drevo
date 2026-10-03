import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { Client } from "pg";
import { accountInvitationsHttp } from "../../src/server/account-invitations-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyInvitationAcceptSessionRevocation(db: StoreDatabase, client: Client) {
  const archiveId = "runtime-test";
  const accountId = "invitation-revoked-account";
  const origin = "https://invitation-session.invalid";
  const invitationId = randomUUID();
  const invitationToken = randomBytes(32).toString("base64url");
  const revokedToken = newSessionToken();
  const activeToken = newSessionToken();
  const revokedHash = sessionTokenHash(revokedToken);
  const activeHash = sessionTokenHash(activeToken);
  const now = Date.now();
  const body = JSON.stringify({ archiveId, token: invitationToken });
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Revoked invitee',$2)",
    [accountId, new Date(now).toISOString()]);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$3,$4),($2,$3,$4)",
    [revokedHash, activeHash, accountId, now + 600_000],
  );
  await client.query(
    `INSERT INTO archive_invitations
       (archive_id,id,token_hash,role,created_by,created_at,expires_at)
     VALUES($1,$2,$3,'reader','owner',$4,$5)`,
    [archiveId, invitationId, createHash("sha256").update(invitationToken).digest("hex"),
      new Date(now).toISOString(), new Date(now + 600_000).toISOString()],
  );
  const auth = await createAuth(await userStore(db), db, origin);
  let reachedAuth!: () => void;
  let resumeAuth!: () => void;
  const authReached = new Promise<void>((resolve) => { reachedAuth = resolve; });
  const authGate = new Promise<void>((resolve) => { resumeAuth = resolve; });
  let gated = false;
  const gate = async (req: { headers: { cookie?: string } }) => {
    if (gated || !req.headers.cookie?.includes(revokedToken)) return;
    gated = true;
    reachedAuth();
    await authGate;
  };
  const handler = accountInvitationsHttp(db, {
    ...auth,
    accountId: async (req) => {
      const id = await auth.accountId(req);
      if (id === accountId) await gate(req);
      return id;
    },
    accountSession: async (req) => {
      const session = await auth.accountSession(req);
      if (session?.accountId === accountId) await gate(req);
      return session;
    },
  }, origin);
  const server = createServer((req, res) => {
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const accept = (token: string) => fetch(base + "/api/account/invitations/accept", {
    method: "POST",
    headers: {
      Origin: origin,
      "Content-Type": "application/json",
      Cookie: `drevo_session=${token}`,
    },
    body,
  });
  try {
    const stale = accept(revokedToken);
    await Promise.race([
      authReached,
      stale.then(() => { throw new Error("Invitation accept finished before auth barrier"); }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Invitation accept missed auth barrier")), 30_000);
        timer.unref();
      }),
    ]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedHash]);
    resumeAuth();
    const response = await stale;
    const membership = await client.query(
      "SELECT role FROM archive_memberships WHERE archive_id=$1 AND user_id=$2", [archiveId, accountId]);
    const invitation = await client.query<{ used_by: string | null }>(
      "SELECT used_by FROM archive_invitations WHERE archive_id=$1 AND id=$2", [archiveId, invitationId]);
    assert.deepEqual({ status: response.status, membership: membership.rowCount,
      usedBy: invitation.rows[0]?.used_by },
    { status: 401, membership: 0, usedBy: null },
    "a revoked session cannot grant membership or consume a one-use invitation");
    await client.query("BEGIN");
    try {
      await client.query("SELECT 1 FROM account_sessions WHERE token_hash=$1 FOR UPDATE", [activeHash]);
      const busy = await Promise.race([
        accept(activeToken),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(new Error("Invitation accept waited on a locked session")), 5_000);
          timer.unref();
        }),
      ]);
      assert.equal(busy.status, 409,
        "a held session gets a retryable conflict without waiting on the archive lock");
      await db.postgresTransaction!(async (archiveClient) => {
        await archiveClient.query("SET LOCAL lock_timeout='1s'");
        await archiveClient.query("SELECT id FROM archives WHERE id=$1 FOR UPDATE", [archiveId]);
      });
    } finally {
      await client.query("ROLLBACK");
    }
    const retry = await accept(activeToken);
    assert.equal(retry.status, 200, await retry.text());
    assert.equal((await accept(activeToken)).status, 200,
      "the same active account can retry a consumed invitation");
    assert.equal((await client.query(
      "SELECT 1 FROM archive_memberships WHERE archive_id=$1 AND user_id=$2", [archiveId, accountId])).rowCount, 1);
    assert.equal((await client.query<{ used_by: string | null }>(
      "SELECT used_by FROM archive_invitations WHERE archive_id=$1 AND id=$2", [archiveId, invitationId]
    )).rows[0]?.used_by, accountId);
    console.log("invitation_accept_session_revocation_verified");
  } finally {
    resumeAuth();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.query("DELETE FROM archive_memberships WHERE archive_id=$1 AND user_id=$2", [archiveId, accountId]);
    await client.query("DELETE FROM archive_invitations WHERE archive_id=$1 AND id=$2", [archiveId, invitationId]);
    await client.query("DELETE FROM account_sessions WHERE token_hash IN ($1,$2)", [revokedHash, activeHash]);
    await client.query("DELETE FROM accounts WHERE id=$1", [accountId]);
  }
}
