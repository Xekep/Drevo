import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Client } from "pg";
import { createAuth } from "../../src/server/auth.ts";
import { archiveOwnerTransferHttp } from "../../src/server/archive-owner-transfer-http.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { userStore } from "../../src/server/users.ts";

export async function verifyOwnerTransferGetRevocation(db: StoreDatabase, client: Client) {
  const origin = "https://owner-transfer-revoke.invalid";
  const activeToken = newSessionToken();
  const activeHash = sessionTokenHash(activeToken);
  const paths = [
    "/api/account/owner-transfer",
    `/api/account/owner-transfer/candidates?q=${encodeURIComponent("Читатель")}`,
  ];
  await client.query("SELECT set_config('drevo.archive_id','runtime-test',false)");
  assert.equal((await client.query(
    "SELECT 1 FROM archive_owner_transfers WHERE archive_id='runtime-test'",
  )).rowCount, 0);
  const now = Date.now();
  await client.query(
    `INSERT INTO archive_owner_transfers(archive_id,from_user_id,to_user_id,created_ms,expires_ms)
     VALUES('runtime-test','owner','reader',$1,$2)`,
    [now, now + 600_000],
  );
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [activeHash, now + 600_000],
  );
  const auth = await createAuth(await userStore(db), db, origin);
  const results: Array<{ path: string; status: number; body: string }> = [];
  try {
    for (const path of paths) {
      const revokedToken = newSessionToken();
      const revokedHash = sessionTokenHash(revokedToken);
      await client.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
        [revokedHash, Date.now() + 600_000],
      );
      let reachedAuth!: () => void;
      let resumeAuth!: () => void;
      const authReached = new Promise<void>((resolve) => { reachedAuth = resolve; });
      const authGate = new Promise<void>((resolve) => { resumeAuth = resolve; });
      const handler = archiveOwnerTransferHttp(db, {
        ...auth,
        accountSession: async (req) => {
          const session = await auth.accountSession(req);
          if (session?.tokenHash === revokedHash) {
            reachedAuth();
            await authGate;
          }
          return session;
        },
      }, origin);
      const server = createServer((req, res) => {
        void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
          .catch((error) => res.destroy(error));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const current = await fetch(base + path, {
          headers: { Cookie: `drevo_session=${activeToken}` },
        });
        assert.equal(current.status, 200);
        assert.match(await current.text(), /Читатель/,
          "an active owner sees the pending recipient or eligible candidate");
        const stale = fetch(base + path, {
          headers: { Cookie: `drevo_session=${revokedToken}` },
        });
        await Promise.race([
          authReached,
          stale.then(() => { throw new Error("Owner-transfer GET completed before auth barrier"); }),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("Owner-transfer GET missed auth barrier")), 30_000);
            timer.unref();
          }),
        ]);
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [revokedHash]);
        resumeAuth();
        const response = await stale;
        results.push({ path, status: response.status, body: await response.text() });
      } finally {
        resumeAuth();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    assert.deepEqual(results.map(({ status }) => status), [401, 401],
      "a revoked owner session cannot receive either prepared owner-transfer GET");
    for (const { body } of results)
      assert.doesNotMatch(body, /Читатель|targetName|eligible/);
    console.log("owner_transfer_get_revocation_verified");
    for (const path of paths) {
      const token = newSessionToken();
      const hash = sessionTokenHash(token);
      await client.query(
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
        [hash, Date.now() + 600_000],
      );
      let reachedAuth!: () => void;
      let resumeAuth!: () => void;
      const authReached = new Promise<void>((resolve) => { reachedAuth = resolve; });
      const authGate = new Promise<void>((resolve) => { resumeAuth = resolve; });
      const handler = archiveOwnerTransferHttp(db, {
        ...auth,
        accountSession: async (req) => {
          const session = await auth.accountSession(req);
          if (session?.tokenHash === hash) {
            reachedAuth();
            await authGate;
          }
          return session;
        },
      }, origin);
      const server = createServer((req, res) => {
        void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`))
          .catch((error) => res.destroy(error));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const pending = fetch(base + path, {
          headers: { Cookie: `drevo_session=${token}` },
        });
        await Promise.race([
          authReached,
          pending.then(() => { throw new Error("Owner-transfer GET completed before auth barrier"); }),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("Owner-transfer GET missed auth barrier")), 30_000);
            timer.unref();
          }),
        ]);
        await client.query(
          "UPDATE archive_owners SET user_id='reader' WHERE archive_id='runtime-test'",
        );
        resumeAuth();
        const response = await pending;
        assert.equal(response.status, path.includes("candidates") ? 403 : 200);
        assert.doesNotMatch(await response.text(), /Читатель|targetName|eligible/,
          "a former owner cannot receive the prepared recipient or candidate names");
      } finally {
        resumeAuth();
        await client.query(
          "UPDATE archive_owners SET user_id='owner' WHERE archive_id='runtime-test'",
        );
        await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
    console.log("owner_transfer_get_owner_change_verified");
  } finally {
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [activeHash]);
    await client.query("DELETE FROM archive_owner_transfers WHERE archive_id='runtime-test'");
  }
}
