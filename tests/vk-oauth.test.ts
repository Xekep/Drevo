import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../src/server/index.ts";
import { userStore } from "../src/server/users.ts";

test("VK ID reuses secure archive sessions, isolates identities and validates every callback", async () => {
  const env = {
    PUBLIC_ORIGIN: "https://mydrevo.org",
    VK_CLIENT_ID: "12345",
    YANDEX_CLIENT_ID: "yandex-app",
    YANDEX_CLIENT_SECRET: "server-secret",
    INITIAL_ADMIN_YANDEX_ID: "77",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((key) => [key, process.env[key]]),
  );
  Object.assign(process.env, env);
  const dir = mkdtempSync(join(tmpdir(), "drevo-vk-"));
  let challenge = "",
    state = "",
    calls = 0;
  let failure = "";
  const upstream: typeof fetch = async (input, init) => {
    calls++;
    assert.ok(init?.signal);
    assert.ok(!String(input).includes("private-token"));
    if (failure === "timeout")
      throw new DOMException("private-token", "TimeoutError");
    if (failure === "unavailable")
      return new Response("private-token", { status: 503 });
    if (failure === "rate-limit")
      return new Response("private-token", { status: 429 });
    if (failure === "malformed") return new Response("not-json-private-token");
    const body = init!.body as URLSearchParams;
    assert.equal(init?.method, "POST");
    assert.equal(body.get("client_id"), "12345");
    if (String(input).endsWith("/oauth2/auth")) {
      assert.equal(body.get("grant_type"), "authorization_code");
      assert.equal(
        body.get("redirect_uri"),
        "https://mydrevo.org/auth/vk/callback",
      );
      assert.equal(body.get("device_id"), "device");
      assert.equal(body.get("state"), state);
      assert.equal(
        createHash("sha256")
          .update(body.get("code_verifier")!)
          .digest("base64url"),
        challenge,
      );
      assert.equal(body.get("client_secret"), null);
      if (failure === "provider-error")
        return Response.json({
          error: "invalid_grant",
          error_description: "private-token",
        });
      return Response.json({
        access_token: "private-token",
        refresh_token: "private-refresh",
        user_id: 77,
        state: failure === "token-state" ? "wrong" : state,
      });
    }
    assert.equal(String(input), "https://id.vk.ru/oauth2/user_info");
    assert.equal(body.get("access_token"), "private-token");
    return Response.json({
      user: {
        user_id: failure === "identity" ? "88" : "77",
        first_name: "Анна",
        last_name: "Иванова",
      },
    });
  };
  const app = await startServer(0, join(dir, "archive.sqlite"), true, upstream);
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  async function begin(provider = "vk") {
    const response = await fetch(`${base}/auth/${provider}`, {
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const target = new URL(response.headers.get("location")!);
    state = target.searchParams.get("state")!;
    challenge = target.searchParams.get("code_challenge")!;
    if (provider === "vk") {
      assert.equal(target.origin, "https://id.vk.ru");
      assert.equal(target.searchParams.get("code_challenge_method"), "s256");
      assert.equal(target.searchParams.get("scope"), null);
      assert.match(
        response.headers.get("set-cookie")!,
        /HttpOnly; SameSite=Lax; Path=\/auth\/vk; Max-Age=600; Secure/,
      );
    }
    return response.headers.get("set-cookie")!.split(";")[0];
  }
  const callback = (cookie?: string, query = "code=code&device_id=device") =>
    fetch(`${base}/auth/vk/callback?state=${state}&${query}`, {
      redirect: "manual",
      headers: cookie ? { Cookie: cookie } : {},
    });
  try {
    const users = await userStore(app.archive.db);
    const vkFirst = await (
      await userStore(app.archive.db, {
        requireInitialAdmin: false,
      })
    ).register("vk:99", "Первый VK");
    assert.equal(vkFirst.role, "reader");
    assert.equal(vkFirst.approved, false);
    assert.equal((await users.register("77", "Владелец Яндекс")).role, "admin");
    const session = await fetch(`${base}/api/session`).then((r) => r.json());
    assert.equal(session.vk, true);
    assert.equal(session.yandex, true);
    assert.doesNotMatch(
      JSON.stringify(session),
      /12345|server-secret|private-token/,
    );
    let cookie = await begin();
    assert.equal((await callback()).status, 400);
    assert.equal(calls, 0);
    const loggedIn = await callback(cookie);
    assert.equal(loggedIn.status, 303);
    const sessionCookie = loggedIn.headers
      .getSetCookie()
      .find((item) => item.startsWith("drevo_session="))!
      .split(";")[0];
    assert.ok(sessionCookie);
    const signedIn = await fetch(`${base}/api/session`, {
      headers: { Cookie: sessionCookie },
    }).then((r) => r.json());
    assert.equal(signedIn.user.id, "vk:77");
    assert.equal(signedIn.user.name, "Анна Иванова");
    assert.equal(signedIn.user.role, "reader");
    assert.equal(signedIn.user.approved, false);
    assert.equal((await users.get("77"))?.name, "Владелец Яндекс");
    assert.equal(
      (
        await fetch(`${base}/api/family`, {
          headers: { Cookie: sessionCookie },
        })
      ).status,
      401,
    );
    assert.doesNotMatch(
      JSON.stringify(signedIn) +
        JSON.stringify([...loggedIn.headers]) +
        (await loggedIn.text()),
      /private-token|private-refresh|server-secret/,
    );
    assert.equal((await callback(cookie)).status, 400);
    assert.equal(calls, 2);
    cookie = await begin();
    assert.equal((await callback(cookie, "error=access_denied")).status, 400);
    assert.equal(calls, 2);
    cookie = await begin();
    await app.archive.db
      .prepare("UPDATE oauth_transactions SET expires_at=0")
      .run();
    assert.equal((await callback(cookie)).status, 400);
    assert.equal(calls, 2);
    await begin("yandex");
    assert.equal(
      (await callback(`drevo_vk_oauth_state=${state}`)).status,
      400,
      "Yandex state cannot be consumed by VK",
    );
    assert.equal(calls, 2);
    cookie = await begin();
    assert.equal((await callback(cookie, "code=code")).status, 502);
    assert.equal(calls, 2, "device ID is required before upstream requests");
    for (const kind of [
      "token-state",
      "identity",
      "provider-error",
      "timeout",
      "unavailable",
      "rate-limit",
      "malformed",
    ]) {
      failure = kind;
      cookie = await begin();
      const failed = await callback(cookie);
      assert.equal(failed.status, 502, kind);
      assert.doesNotMatch(
        await failed.text(),
        /private-token|private-refresh|server-secret|stack|invalid_grant/,
      );
      assert.ok(
        !failed.headers
          .getSetCookie()
          .some((value) => value.startsWith("drevo_session=")),
      );
    }
    assert.equal(
      (await fetch(`${base}/auth/vk`, { method: "POST" })).status,
      405,
    );
  } finally {
    await app.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
