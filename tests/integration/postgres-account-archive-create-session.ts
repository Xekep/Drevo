import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Client } from "pg";
import { accountArchiveDirectory } from "../../src/server/account-archives.ts";
import { accountArchivesHttp } from "../../src/server/account-archives-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyAccountArchiveCreateSessionRevocation(db: StoreDatabase, client: Client) {
  const previousContext = (await client.query<{
    archive_id: string | null; account_id: string | null;
  }>(`SELECT current_setting('drevo.archive_id',true) AS archive_id,
             current_setting('drevo.account_id',true) AS account_id`)).rows[0];
  const accountId = "archive-create-revoked-account";
  const deletingAccountId = "archive-create-deleting-account";
  const origin = "https://archive-create-session.invalid";
  const revokedToken = newSessionToken();
  const activeToken = newSessionToken();
  const secondActiveToken = newSessionToken();
  const revokedHash = sessionTokenHash(revokedToken);
  const activeHash = sessionTokenHash(activeToken);
  const secondActiveHash = sessionTokenHash(secondActiveToken);
  const deletingToken = newSessionToken();
  const deletingHash = sessionTokenHash(deletingToken);
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'New private archive',$2)",
    [accountId, new Date().toISOString()]);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$4,$5),($2,$4,$5),($3,$4,$5)",
    [revokedHash, activeHash, secondActiveHash, accountId, Date.now() + 600_000],
  );
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Deleting account',$2)",
    [deletingAccountId, new Date().toISOString()]);
  await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)",
    [deletingHash, deletingAccountId, Date.now() + 600_000]);
  const auth = await createAuth(await userStore(db), db, origin);
  let reachedAuth!: () => void;
  let resumeAuth!: () => void;
  const authReached = new Promise<void>((resolve) => { reachedAuth = resolve; });
  const authGate = new Promise<void>((resolve) => { resumeAuth = resolve; });
  let reachedDeletionAuth!: () => void;
  let resumeDeletionAuth!: () => void;
  const deletionAuthReached = new Promise<void>((resolve) => { reachedDeletionAuth = resolve; });
  const deletionAuthGate = new Promise<void>((resolve) => { resumeDeletionAuth = resolve; });
  const gate = async (req: { headers: { cookie?: string } }, id: string | undefined) => {
    if (id === accountId && req.headers.cookie?.includes(revokedToken)) {
      reachedAuth();
      await authGate;
    }
    if (id === deletingAccountId && req.headers.cookie?.includes(deletingToken)) {
      reachedDeletionAuth();
      await deletionAuthGate;
    }
  };
  const handler = accountArchivesHttp({
    ...auth,
    accountId: async (req) => {
      const id = await auth.accountId(req);
      await gate(req, id || undefined);
      return id;
    },
    accountSession: async (req) => {
      const session = await auth.accountSession(req);
      await gate(req, session?.accountId);
      return session;
    },
  }, accountArchiveDirectory(db), db, origin, true);
  const server = createServer((req, res) => {
    if (req.url === "/auth/logout") {
      void auth.logout(req, res).then(() => {
        res.writeHead(200);
        res.end();
      }).catch((error) => res.destroy(error));
      return;
    }
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
      .catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const create = (token: string) => fetch(base + "/api/account/archives", {
    method: "POST",
    headers: { Origin: origin, "X-Drevo-New-Archive": "1",
      Cookie: `drevo_session=${token}` },
  });
  const waitForBlockedQuery = async (fragment: string) => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await client.query("SELECT pg_stat_clear_snapshot()");
      const waiting = await client.query<{ blocked: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_stat_activity
          WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
            AND query LIKE $1) AS blocked`,
        [`%${fragment}%`],
      );
      if (waiting.rows[0]?.blocked) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Expected blocked PostgreSQL query: ${fragment}`);
  };
  try {
    const stale = create(revokedToken);
    await Promise.race([
      authReached,
      stale.then(() => { throw new Error("Archive creation finished before auth barrier"); }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Archive creation missed auth barrier")), 30_000);
        timer.unref();
      }),
    ]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedHash]);
    resumeAuth();
    const response = await stale;
    await client.query("SELECT set_config('drevo.account_id',$1,false)", [accountId]);
    const owned = await client.query("SELECT archive_id FROM archive_owners WHERE user_id=$1", [accountId]);
    assert.deepEqual({ status: response.status, owned: owned.rowCount },
      { status: 401, owned: 0 },
      "a revoked session cannot create a private archive after HTTP authentication");
    await client.query("BEGIN");
    try {
      await client.query("SELECT 1 FROM account_sessions WHERE token_hash=$1 FOR UPDATE", [activeHash]);
      const busy = await create(activeToken);
      assert.equal(busy.status, 409,
        "a concurrent session mutation makes archive creation retryable");
      assert.equal((await client.query("SELECT archive_id FROM archive_owners WHERE user_id=$1", [accountId])).rowCount, 0);
    } finally {
      await client.query("ROLLBACK");
    }
    // Provisioning waits on this advisory lock only after locking both the
    // account and session rows. Logout must then wait for the whole create.
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(2405, hashtext($1))", [accountId]);
    const active = create(activeToken);
    let logout: Promise<Response> | undefined;
    try {
      await waitForBlockedQuery("pg_advisory_xact_lock(2405");
      logout = fetch(base + "/auth/logout", {
        method: "POST",
        headers: { Origin: origin, Cookie: `drevo_session=${activeToken}` },
      });
      await waitForBlockedQuery("DELETE FROM account_sessions WHERE token_hash");
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    assert.equal(logout && (await logout).status, 200,
      "HTTP logout waits until the private archive creation commits");
    assert.equal((await create(activeToken)).status, 401,
      "the revoked session cannot retry archive creation");
    const created = await active;
    assert.equal(created.status, 201, created.status === 201 ? "" : await created.text());
    const archiveId = (await created.json()).archiveId;
    assert.equal((await client.query("SELECT archive_id FROM archive_owners WHERE user_id=$1", [accountId]))
      .rows[0]?.archive_id, archiveId);
    assert.equal((await create(secondActiveToken)).status, 409,
      "the active session cannot create a second owned archive");
    const deleting = create(deletingToken);
    await Promise.race([
      deletionAuthReached,
      deleting.then(() => { throw new Error("Archive creation finished before deletion auth barrier"); }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Archive creation missed deletion auth barrier")), 30_000);
        timer.unref();
      }),
    ]);
    await client.query("BEGIN");
    try {
      await client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE", [deletingAccountId]);
      resumeDeletionAuth();
      await client.query("DELETE FROM accounts WHERE id=$1", [deletingAccountId]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
    assert.equal((await deleting).status, 401,
      "account deletion wins the account lock and blocks stale archive creation");
    console.log("account_archive_create_session_revocation_verified");
  } finally {
    resumeAuth();
    resumeDeletionAuth();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.query("SELECT set_config('drevo.account_id',$1,false)", [accountId]);
    const owned = await client.query("SELECT archive_id FROM archive_owners WHERE user_id=$1", [accountId]);
    for (const row of owned.rows) {
      await client.query("SELECT set_config('drevo.archive_id',$1,false)", [row.archive_id]);
      await client.query("DELETE FROM archive_owners WHERE archive_id=$1", [row.archive_id]);
      await client.query("DELETE FROM archive_memberships WHERE archive_id=$1", [row.archive_id]);
      await client.query("DELETE FROM archives WHERE id=$1", [row.archive_id]);
    }
    await client.query("DELETE FROM account_sessions WHERE token_hash IN ($1,$2,$3)",
      [revokedHash, activeHash, secondActiveHash]);
    await client.query("DELETE FROM accounts WHERE id=$1", [accountId]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [deletingHash]);
    await client.query("DELETE FROM accounts WHERE id=$1", [deletingAccountId]);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)", [previousContext.archive_id || ""]);
    await client.query("SELECT set_config('drevo.account_id',$1,false)", [previousContext.account_id || ""]);
  }
}
