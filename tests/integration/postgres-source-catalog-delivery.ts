import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Client } from "pg";
import type { openArchive } from "../../src/server/database.ts";
import { createAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import { sourceCatalogHttp } from "../../src/server/source-catalog-http.ts";
import { sourceCatalogStore } from "../../src/server/source-catalog-store.ts";
import { parseCatalogSource } from "../../src/shared/source-catalog.ts";
import { newSessionToken, sessionTokenHash } from "../../src/server/session-token.ts";

export async function verifySourceCatalogDelivery(archive: Awaited<ReturnType<typeof openArchive>>, client: Client) {
  const db = archive.db;
  const prepare = db.prepare.bind(db);
  const token = newSessionToken(), hash = sessionTokenHash(token);
  const auth = await createAuth(await userStore(db), db, "https://source-delivery.invalid");
  const membership = (await client.query("SELECT * FROM archive_memberships WHERE archive_id='runtime-test' AND user_id='owner'")).rows[0];
  assert.ok(membership);
  const source = parseCatalogSource({ id: "delivery-private-source", title: "Private delivery source",
    description: "Confidential delivery note", type: "", author: "", institution: "", archive: "",
    fond: "", opis: "", delo: "", sheet: "", reference: "", url: "", accessedAt: "", documentIds: [] })!;
  await sourceCatalogStore(db).insert(source);
  const reset = async () => {
    await client.query(`INSERT INTO archive_memberships SELECT * FROM jsonb_populate_record(NULL::archive_memberships,$1::jsonb)
      ON CONFLICT(archive_id,user_id) DO UPDATE SET role=excluded.role,approved=excluded.approved,person_id=excluded.person_id,tree_access=excluded.tree_access`, [JSON.stringify(membership)]);
    await client.query("INSERT INTO archive_owners(archive_id,user_id) VALUES('runtime-test','owner') ON CONFLICT(archive_id) DO UPDATE SET user_id='owner'");
    await client.query("INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2) ON CONFLICT(token_hash) DO UPDATE SET expires_at=excluded.expires_at", [hash, Date.now() + 600_000]);
  };
  await reset();
  let handler = sourceCatalogHttp(archive, auth);
  let stall = false;
  const server = createServer((req, res) => {
    if (stall) res.end = (() => res) as typeof res.end;
    void handler(req, res, new URL(req.url || "/", `http://${req.headers.host}`)).catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const headers = { Cookie: `drevo_session=${token}` };
  let release = () => {};
  try {
    for (const path of ["/api/sources", `/api/sources/${source.id}`]) {
      const normal = await fetch(base + path, { headers });
      assert.equal(normal.status, 200);
      assert.match(await normal.text(), /Confidential delivery note/);
      for (const revoke of ["approval", "membership", "owner", "session"]) {
        let reached!: () => void;
        const entered = new Promise<void>((resolve) => { reached = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        db.prepare = ((...args: Parameters<typeof prepare>) => {
          const statement = prepare(...args);
          if (!args[0].startsWith("SELECT data,version FROM source_catalog")) return statement;
          return new Proxy(statement, { get(target, key, receiver) {
            if (key !== "all" && key !== "get") return Reflect.get(target, key, receiver);
            return async (...values: Parameters<typeof statement.get>) => {
              const result = await statement[key](...values);
              reached(); await gate; return result;
            };
          } });
        }) as typeof prepare;
        const pending = fetch(base + path, { headers });
        try {
          await Promise.race([entered, pending.then(() => { throw new Error("Source delivery barrier missed"); })]);
          if (revoke === "approval") await client.query("UPDATE archive_memberships SET approved=false WHERE archive_id='runtime-test' AND user_id='owner'");
          if (revoke === "membership") {
            // A current owner cannot lose membership before ownership transfer:
            // exercise a valid revocation without weakening that FK invariant.
            await client.query("UPDATE archive_owners SET user_id='reader' WHERE archive_id='runtime-test'");
            await client.query("DELETE FROM archive_memberships WHERE archive_id='runtime-test' AND user_id='owner'");
          }
          if (revoke === "owner") await client.query("DELETE FROM archive_owners WHERE archive_id='runtime-test' AND user_id='owner'");
          if (revoke === "session") await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
          release();
          const response = await pending;
          assert.equal(response.status, revoke === "session" ? 401 : 403, `${path}: ${revoke}`);
          assert.doesNotMatch(await response.text(), /Private delivery source|Confidential delivery note/);
        } finally { release(); db.prepare = prepare; await pending.catch(() => {}); await reset(); }
      }
    }
    // Once delivery is authorized, revocation must wait for that bounded
    // response rather than race between the final check and res.end().
    const revokerPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    for (const slow of [false, true]) {
      stall = slow;
      let locked!: () => void;
      const entered = new Promise<void>((resolve) => { locked = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      handler = sourceCatalogHttp(archive, {
        ...auth,
        currentUser: async (req) => {
          if (db.inTransaction()) { locked(); await gate; }
          return auth.currentUser(req);
        },
      });
      const pending = fetch(base + `/api/sources/${source.id}`, { headers }).then(
        async (response) => ({ status: response.status, body: await response.text() }),
        () => null,
      );
      let revocation: Promise<unknown> | undefined;
      try {
        await Promise.race([entered, pending.then(() => { throw new Error("Locked source delivery barrier missed"); })]);
        revocation = client.query("UPDATE archive_memberships SET approved=false WHERE archive_id='runtime-test' AND user_id='owner'");
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          blocked = !!(await prepare("", "SELECT 1 FROM pg_locks WHERE pid=? AND NOT granted").get(revokerPid));
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 20));
        }
        assert.ok(blocked, "delivery holds the membership capability through res.end()");
        const started = Date.now();
        release();
        const response = await pending;
        await revocation;
        if (slow) {
          assert.equal(response, null, "a stalled response is destroyed instead of retaining permission locks");
          assert.ok(Date.now() - started < 7_000, "the delivery deadline releases revocation within its bounded window");
        } else {
          assert.equal(response?.status, 200);
          assert.match(response?.body || "", /Confidential delivery note/);
        }
      } finally {
        release(); server.closeAllConnections();
        await pending; await revocation;
        await reset(); stall = false;
      }
    }
  } finally {
    release(); db.prepare = prepare;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [hash]);
    await sourceCatalogStore(db).remove(source.id, 1);
  }
  console.log("source_catalog_revoked_delivery_verified");
}
