import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../src/server/session-token.ts";

test("VK admin settings are protected, persistent and take effect without restart", async () => {
  const saved = {
    PUBLIC_ORIGIN: process.env.PUBLIC_ORIGIN,
    INITIAL_ADMIN_YANDEX_ID: process.env.INITIAL_ADMIN_YANDEX_ID,
    VK_CLIENT_ID: process.env.VK_CLIENT_ID,
  };
  Object.assign(process.env, {
    PUBLIC_ORIGIN: "https://mydrevo.org",
    INITIAL_ADMIN_YANDEX_ID: "owner",
    VK_CLIENT_ID: "12345",
  });
  const directory = mkdtempSync(join(tmpdir(), "drevo-vk-settings-"));
  let calls = 0;
  let app = await startServer(
    0,
    join(directory, "test.sqlite"),
    true,
    async () => {
      calls++;
      throw new Error("Must not call VK for an obsolete configuration");
    },
  );
  try {
    let base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    const users = await userStore(app.archive.db);
    const owner = await users.register("owner", "Владелец");
    await users.register("reader", "Читатель");
    await users.setApproved(owner, "reader", true);
    const cookies: Record<string, string> = {};
    for (const id of ["owner", "reader"]) {
      const token = newSessionToken();
      await app.archive.db
        .prepare(
          "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
        )
        .run(sessionTokenHash(token), id, Date.now() + 600_000);
      cookies[id] = `drevo_session=${token}`;
    }
    const get = () =>
      fetch(`${base}/api/admin/auth/vk`, {
        headers: { Cookie: cookies.owner },
      });
    const put = (
      body: unknown,
      user = "owner",
      origin = "https://mydrevo.org",
    ) =>
      fetch(`${base}/api/admin/auth/vk`, {
        method: "PUT",
        headers: {
          Cookie: cookies[user],
          Origin: origin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    const available = async () =>
      (await fetch(`${base}/api/session`).then((r) => r.json())).vk;
    assert.equal((await fetch(`${base}/api/admin/auth/vk`)).status, 401);
    assert.equal(
      (
        await fetch(`${base}/api/admin/auth/vk`, {
          headers: { Cookie: cookies.reader },
        })
      ).status,
      403,
    );
    assert.equal(
      (await put({ enabled: false, clientId: "" }, "reader")).status,
      403,
    );
    assert.equal(
      (
        await put(
          { enabled: false, clientId: "" },
          "owner",
          "https://elsewhere.invalid",
        )
      ).status,
      403,
    );
    assert.equal(
      (await put({ enabled: true, clientId: "not-an-id" })).status,
      400,
    );
    assert.equal((await put({ enabled: true, clientId: "" })).status, 400);
    assert.equal(
      (await put({ enabled: true, clientId: "1".repeat(5000) })).status,
      413,
    );
    assert.equal((await get()).headers.get("cache-control"), "no-store");
    assert.equal(
      await available(),
      true,
      "existing environment settings remain usable before first save",
    );
    const started = await fetch(`${base}/auth/vk`, { redirect: "manual" });
    const state = new URL(started.headers.get("location")!).searchParams.get(
      "state",
    );
    const cookie = started.headers.getSetCookie()[0].split(";")[0];
    assert.equal((await put({ enabled: true, clientId: "67890" })).status, 200);
    const obsolete = await fetch(
      `${base}/auth/vk/callback?state=${state}&code=code&device_id=device`,
      { redirect: "manual", headers: { Cookie: cookie } },
    );
    assert.equal(
      obsolete.status,
      400,
      "a callback cannot cross client configurations",
    );
    assert.equal(calls, 0);
    const next = await fetch(`${base}/auth/vk`, { redirect: "manual" });
    assert.equal(
      new URL(next.headers.get("location")!).searchParams.get("client_id"),
      "67890",
    );
    assert.equal((await put({ enabled: false, clientId: "" })).status, 200);
    assert.equal(
      await available(),
      false,
      "clearing saved settings overrides the environment",
    );
    assert.equal(
      (await fetch(`${base}/auth/vk`, { redirect: "manual" })).status,
      503,
    );
    await app.close();
    app = await startServer(0, join(directory, "test.sqlite"), true);
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    assert.equal(await available(), false);
    assert.equal(
      (await get()).status,
      200,
      "existing account sessions remain valid",
    );
    assert.equal(
      (
        await app.archive.db
          .prepare(
            "SELECT count(*) AS n FROM audit_entries WHERE entity_id='vk-auth'",
          )
          .get()
      )?.n,
      2,
    );
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  }
});
