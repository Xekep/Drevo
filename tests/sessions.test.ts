import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth, SESSION_MAX_AGE } from "../src/server/auth.ts";
import { userStore } from "../src/server/users.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";

test("persistent sessions survive server restart, renew on activity and revoke on logout", async () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-sessions-"));
  function open() {
    const db = new DatabaseSync(join(directory, "sessions.sqlite"));
    initializeArchiveSchema(db);
    const users = userStore(db);
    const auth = createAuth(users, db, "https://drevo.kiiko.ru");
    const server = createServer((req, res) => {
      if (req.url === "/login") {
        res.setHeader("Set-Cookie", "oauth_state=; Max-Age=0; Path=/");
        auth.issueSession(req, res, { id: "test-user", name: "Участник" });
      } else if (req.url === "/logout") auth.logout(req, res);
      else auth.refreshSession(req, res);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ user: auth.currentUser(req) }));
    });
    return { db, users, server };
  }
  let app = open();
  async function listen() {
    await new Promise<void>((resolve) =>
      app.server.listen(0, "127.0.0.1", resolve),
    );
  }
  async function close() {
    await new Promise<void>((resolve, reject) =>
      app.server.close((error) => (error ? reject(error) : resolve())),
    );
    app.db.close();
  }
  const request = (path: string, cookie = "", headers = {}) => {
    const port = (app.server.address() as { port: number }).port;
    return fetch(`http://127.0.0.1:${port}${path}`, {
      headers: { Cookie: cookie, ...headers },
    });
  };
  try {
    await listen();
    const login = await request("/login");
    const cookies = login.headers.getSetCookie();
    const issued = cookies.find((c) => c.startsWith("drevo_session="))!;
    const cookie = issued.split(";")[0];
    const token = cookie.slice("drevo_session=".length);
    assert.equal(cookies.length, 2, "OAuth state cleanup is retained");
    assert.match(
      issued,
      /HttpOnly; SameSite=Lax; Path=\/; Max-Age=7776000; Secure/,
    );
    const stored = app.db.prepare("SELECT * FROM auth_sessions").get()!;
    assert.notEqual(stored.token_hash, token, "only the hash is persisted");
    assert.equal(
      (await request("/session", cookie).then((r) => r.json())).user.role,
      "admin",
    );
    await close();
    app = open();
    await listen();
    assert.equal(
      (await request("/session", cookie).then((r) => r.json())).user.id,
      "test-user",
    );
    assert.equal(
      (
        await request("/session", "drevo_session=" + "0".repeat(64)).then((r) =>
          r.json(),
        )
      ).user,
      null,
    );
    assert.equal(
      (await request("/session", "drevo_session=bad").then((r) => r.json()))
        .user,
      null,
    );

    app.db
      .prepare("UPDATE auth_sessions SET expires_at=?")
      .run(Date.now() + 60_000);
    assert.equal(
      (
        await request("/session", cookie, { "Sec-Fetch-Site": "cross-site" })
      ).headers.get("set-cookie"),
      null,
    );
    const renewed = await request("/session", cookie);
    assert.ok(renewed.headers.getSetCookie().some((c) => c.startsWith(cookie)));
    assert.ok(
      Number(
        app.db.prepare("SELECT expires_at FROM auth_sessions").get()!
          .expires_at,
      ) >
        Date.now() + (SESSION_MAX_AGE - 60) * 1000,
    );
    assert.equal(
      (await request("/session", cookie)).headers.get("set-cookie"),
      null,
      "no renewal for every image or request",
    );

    const admin = app.users.register("second", "Администратор");
    app.users.setRole(app.users.get("test-user")!, admin.id, "admin");
    app.users.setRole(app.users.get("second")!, "test-user", "reader");
    assert.equal(
      (await request("/session", cookie).then((r) => r.json())).user.role,
      "reader",
      "current role is read from SQLite",
    );

    const secondLogin = await request("/login", cookie);
    const secondCookie = secondLogin.headers
      .getSetCookie()
      .find((c) => c.startsWith("drevo_session="))!
      .split(";")[0];
    assert.notEqual(secondCookie, cookie);
    assert.equal(
      (await request("/session", cookie).then((r) => r.json())).user,
      null,
      "signing in replaces the current session",
    );
    const logout = await request("/logout", secondCookie);
    assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
    await close();
    app = open();
    await listen();
    assert.equal(
      (await request("/session", secondCookie).then((r) => r.json())).user,
      null,
      "revoked session stays revoked after restart",
    );
    const thirdLogin = await request("/login");
    const thirdCookie = thirdLogin.headers
      .getSetCookie()
      .find((c) => c.startsWith("drevo_session="))!
      .split(";")[0];
    app.db.prepare("UPDATE auth_sessions SET expires_at=?").run(Date.now() - 1);
    assert.equal(
      (await request("/session", thirdCookie).then((r) => r.json())).user,
      null,
      "expired sessions cannot be renewed",
    );
    assert.equal(
      app.db.prepare("SELECT count(*) AS n FROM auth_sessions").get()!.n,
      0,
    );
  } finally {
    await close();
    rmSync(directory, { recursive: true, force: true });
  }
});
