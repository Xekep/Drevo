import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Client } from "pg";
import { accountArchiveDirectory } from "../../src/server/account-archives.ts";
import { accountArchivesHttp } from "../../src/server/account-archives-http.ts";
import { createAuth } from "../../src/server/auth.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyAccountArchivesReadSessionRevocation(db: StoreDatabase, client: Client) {
  const accountId = "archive-list-revoked-account";
  const archiveId = "runtime-test";
  const origin = "https://archive-list-session.invalid";
  const token = newSessionToken();
  const activeToken = newSessionToken();
  const abortToken = newSessionToken();
  const tokenHash = sessionTokenHash(token);
  const activeHash = sessionTokenHash(activeToken);
  const abortHash = sessionTokenHash(abortToken);
  const previousContext = (await client.query<{ archive_id: string | null }>(
    "SELECT current_setting('drevo.archive_id',true) AS archive_id"
  )).rows[0];
  await client.query("SELECT set_config('drevo.archive_id',$1,false)", [archiveId]);
  await client.query("INSERT INTO accounts(id,name,created_at) VALUES($1,'Archive list reader',$2)",
    [accountId, new Date().toISOString()]);
  await client.query("INSERT INTO archive_memberships(archive_id,user_id,role,approved,tree_access) VALUES($1,$2,'reader',true,'all')",
    [archiveId, accountId]);
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,$4,$5),($2,$4,$5),($3,$4,$5)",
    [tokenHash, activeHash, abortHash, accountId, Date.now() + 600_000],
  );
  const auth = await createAuth(await userStore(db), db, origin);
  let reachedAuth!: () => void;
  let resumeAuth!: () => void;
  const authReached = new Promise<void>((resolve) => { reachedAuth = resolve; });
  const authGate = new Promise<void>((resolve) => { resumeAuth = resolve; });
  let reachedDelivery!: () => void;
  let resumeDelivery!: () => void;
  const deliveryReached = new Promise<void>((resolve) => { reachedDelivery = resolve; });
  const deliveryGate = new Promise<void>((resolve) => { resumeDelivery = resolve; });
  let pauseDelivery = false;
  let beforeFinalRead: (() => Promise<void>) | null = null;
  let reachedStalledEnd: (() => void) | null = null;
  const directory = accountArchiveDirectory(db);
  const handler = accountArchivesHttp({
    ...auth,
    accountId: async (req) => {
      const id = await auth.accountId(req);
      if (id === accountId && req.headers.cookie?.includes(token)) {
        reachedAuth();
        await authGate;
      }
      return id;
    },
    accountSession: async (req) => {
      const session = await auth.accountSession(req);
      if (session?.accountId === accountId && req.headers.cookie?.includes(token)) {
        reachedAuth();
        await authGate;
      }
      return session;
    },
  }, {
    ...directory,
    deliverList: async (userId, sessionHash, archives, deliver) => {
      const change = beforeFinalRead;
      beforeFinalRead = null;
      if (change) await change();
      return directory.deliverList(userId, sessionHash, archives, async () => {
        if (pauseDelivery) {
          reachedDelivery();
          await deliveryGate;
        }
        await deliver();
      });
    },
  }, db, origin, false);
  const server = createServer((req, res) => {
    if (req.headers["x-test-stall"] === "1") {
      // Model a client that never receives the small JSON body; production's
      // response deadline must destroy it and release all PostgreSQL locks.
      res.end = (() => { reachedStalledEnd?.(); return res; }) as typeof res.end;
    }
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
  const list = (cookie: string) => fetch(base + "/api/account/archives",
    { headers: { Cookie: `drevo_session=${cookie}` } });
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
    throw new Error(`Query did not wait for archive list delivery: ${fragment}`);
  };
  const stalledList = (signal?: AbortSignal) => {
    const reached = new Promise<void>((resolve) => { reachedStalledEnd = resolve; });
    const request = fetch(base + "/api/account/archives", {
      headers: { Cookie: `drevo_session=${abortToken}`, "X-Test-Stall": "1" },
      signal,
    });
    void request.catch(() => {});
    return { reached, request };
  };
  const assertLocksReleased = async () => {
    const deadline = Date.now() + 2_000;
    while (true) {
      try {
        await db.postgresTransaction!(async (lockClient) => {
          await lockClient.query("SELECT id FROM archives WHERE id=$1 FOR UPDATE NOWAIT", [archiveId]);
          await lockClient.query("SELECT 1 FROM account_sessions WHERE token_hash=$1 FOR UPDATE NOWAIT", [abortHash]);
        });
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "55P03" || Date.now() >= deadline)
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  };
  try {
    const current = await list(activeToken);
    assert.equal(current.status, 200);
    assert.equal((await current.json()).archives[0]?.id, archiveId);
    const stale = list(token);
    await Promise.race([
      authReached,
      stale.then(() => { throw new Error("Archive list completed before auth barrier"); }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Archive list missed auth barrier")), 30_000);
        timer.unref();
      }),
    ]);
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [tokenHash]);
    resumeAuth();
    const response = await stale;
    assert.equal(response.status, 401,
      "a revoked session cannot receive archive titles after initial HTTP auth");
    assert.doesNotMatch(await response.text(), /Archive list reader|runtime-test|archives|reader/);
    await client.query("BEGIN");
    try {
      await client.query("SELECT 1 FROM account_sessions WHERE token_hash=$1 FOR UPDATE", [activeHash]);
      const busy = await list(activeToken);
      assert.equal(busy.status, 409, "a held session gets a retryable list conflict");
      assert.doesNotMatch(await busy.text(), /Archive list reader|runtime-test|archives|reader/);
    } finally {
      await client.query("ROLLBACK");
    }
    beforeFinalRead = async () => {
      const changed = await client.query(
        "UPDATE archive_memberships SET role='relative' WHERE archive_id=$1 AND user_id=$2",
        [archiveId, accountId],
      );
      assert.equal(changed.rowCount, 1);
    };
    const changed = await list(activeToken);
    assert.equal(changed.status, 409,
      "a changed membership role invalidates the pre-serialized archive list");
    assert.doesNotMatch(await changed.text(), /Archive list reader|runtime-test|archives|reader|relative/);
    await client.query("UPDATE archive_memberships SET role='reader' WHERE archive_id=$1 AND user_id=$2",
      [archiveId, accountId]);
    pauseDelivery = true;
    const delivering = list(activeToken);
    await Promise.race([
      deliveryReached,
      delivering.then(() => { throw new Error("Archive list finished before final delivery barrier"); }),
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Archive list missed final delivery barrier")), 30_000);
        timer.unref();
      }),
    ]);
    // Owner transfer and membership revocation both acquire the archive row
    // before changing roles; they must wait for the response's archive lock.
    const ownerTransferLock = db.postgresTransaction!(async (lockClient) => {
      await lockClient.query("SELECT id FROM archives WHERE id=$1 FOR UPDATE", [archiveId]);
    });
    await waitForBlockedQuery("SELECT id FROM archives WHERE id=$1 FOR UPDATE");
    const logout = fetch(base + "/auth/logout", {
      method: "POST", headers: { Origin: origin, Cookie: `drevo_session=${activeToken}` },
    });
    await waitForBlockedQuery("DELETE FROM account_sessions WHERE token_hash");
    resumeDelivery();
    const delivered = await delivering;
    assert.equal(delivered.status, 200);
    assert.equal((await delivered.json()).archives[0]?.id, archiveId);
    assert.equal((await logout).status, 200,
      "HTTP logout waits until archive names finish sending");
    await ownerTransferLock;
    assert.equal((await list(activeToken)).status, 401);
    const controller = new AbortController();
    const aborted = stalledList(controller.signal);
    await aborted.reached;
    controller.abort();
    await assert.rejects(aborted.request);
    await assertLocksReleased();
    const timedOut = stalledList();
    await timedOut.reached;
    await assert.rejects(timedOut.request);
    await assertLocksReleased();
    console.log("account_archives_read_session_revocation_verified");
  } finally {
    resumeAuth();
    resumeDelivery();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.query("DELETE FROM account_sessions WHERE token_hash IN ($1,$2,$3)",
      [tokenHash, activeHash, abortHash]);
    await client.query("DELETE FROM archive_memberships WHERE archive_id=$1 AND user_id=$2",
      [archiveId, accountId]);
    await client.query("DELETE FROM accounts WHERE id=$1", [accountId]);
    await client.query("SELECT set_config('drevo.archive_id',$1,false)",
      [previousContext.archive_id || ""]);
  }
}
