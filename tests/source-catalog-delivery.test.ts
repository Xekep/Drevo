import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { newSessionToken, sessionTokenHash } from "../src/server/session-token.ts";

test("prepared source pages and direct reads cannot outlive session, approval or owner rights", { timeout: 30_000 }, async () => {
  const previousOrigin = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = "http://localhost";
  const dir = await mkdtemp(join(tmpdir(), "drevo-source-delivery-"));
  const app = await startServer(0, join(dir, "archive.sqlite"), true);
  const db = app.archive.db;
  const prepare = db.prepare.bind(db);
  const token = newSessionToken();
  const hash = sessionTokenHash(token);
  const headers = { Cookie: `drevo_session=${token}`, Origin: "http://localhost", "Content-Type": "application/json" };
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  let release = () => {};
  try {
    await prepare("INSERT INTO users(id,name,role,approved) VALUES('owner','Owner','admin',1)").run();
    await prepare("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(hash, "owner", Date.now() + 600_000);
    const created = await fetch(base + "/api/sources", {
      method: "POST", headers,
      body: JSON.stringify({ title: "Private source", description: "Confidential synthetic description" }),
    });
    assert.equal(created.status, 201);
    const { source } = await created.json() as { source: { id: string } };
    for (const path of ["/api/sources", `/api/sources/${source.id}`]) {
      const normal = await fetch(base + path, { headers });
      assert.equal(normal.status, 200);
      assert.match(await normal.text(), /Confidential synthetic description/);
      for (const revoke of ["approval", "role", "session", "expiry"]) {
        await prepare("UPDATE users SET approved=1,role='admin' WHERE id='owner'").run();
        await prepare("INSERT OR REPLACE INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
          .run(hash, "owner", Date.now() + 600_000);
        let reached!: () => void;
        const entered = new Promise<void>((resolve) => { reached = resolve; });
        const gate = new Promise<void>((resolve) => { release = resolve; });
        db.prepare = ((...args: Parameters<typeof prepare>) => {
          const statement = prepare(...args);
          if (!args[0].startsWith("SELECT data,version FROM source_catalog")) return statement;
          return new Proxy(statement, {
            get(target, key, receiver) {
              if (key !== "all" && key !== "get") return Reflect.get(target, key, receiver);
              return async (...values: Parameters<typeof statement.get>) => {
                const result = await statement[key](...values);
                reached();
                await gate;
                return result;
              };
            },
          });
        }) as typeof prepare;
        const pending = fetch(base + path, { headers });
        try {
          await Promise.race([entered, pending.then(() => { throw new Error("Catalog read missed barrier"); })]);
          if (revoke === "approval") await prepare("UPDATE users SET approved=0 WHERE id='owner'").run();
          if (revoke === "role") await prepare("UPDATE users SET role='reader' WHERE id='owner'").run();
          if (revoke === "session") await prepare("DELETE FROM auth_sessions WHERE token_hash=?").run(hash);
          if (revoke === "expiry") await prepare("UPDATE auth_sessions SET expires_at=0 WHERE token_hash=?").run(hash);
          release();
          const response = await pending;
          assert.equal(response.status, revoke === "session" || revoke === "expiry" ? 401 : 403, `${path}: ${revoke}`);
          assert.doesNotMatch(await response.text(), /Confidential synthetic description|Private source/);
        } finally { release(); db.prepare = prepare; await pending.catch(() => {}); }
      }
      await prepare("UPDATE users SET approved=1,role='admin' WHERE id='owner'").run();
      await prepare("INSERT OR REPLACE INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
        .run(hash, "owner", Date.now() + 600_000);
    }
  } finally {
    release(); db.prepare = prepare;
    await app.close();
    await rm(dir, { recursive: true, force: true });
    if (previousOrigin === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previousOrigin;
  }
});
