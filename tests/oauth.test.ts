import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { createYandexOAuth } from "../src/server/yandex-oauth.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";

test("Yandex OAuth checks state, uses PKCE, accepts new accounts and consumes the callback once", async () => {
  let tokenCalls = 0,
    profileId = "allowed",
    issued = 0,
    challenge = "";
  const fetcher: typeof fetch = async (input, init) => {
    if (String(input).includes("/token")) {
      tokenCalls++;
      const body = init!.body as URLSearchParams;
      assert.equal(
        createHash("sha256")
          .update(body.get("code_verifier")!)
          .digest("base64url"),
        challenge,
      );
      assert.equal(
        body.get("redirect_uri"),
        "https://drevo.kiiko.ru/auth/yandex/callback",
      );
      assert.equal(body.get("client_secret"), "secret");
      return Response.json({ access_token: "private-token" });
    }
    assert.equal(
      (init!.headers as Record<string, string>).Authorization,
      "OAuth private-token",
    );
    assert.ok(!String(input).includes("private-token"));
    return Response.json({ id: profileId });
  };
  const db = new DatabaseSync(":memory:");
  initializeArchiveSchema(db);
  const oauth = createYandexOAuth({
    origin: "https://drevo.kiiko.ru",
    clientId: "client",
    clientSecret: "secret",
    fetcher,
    issueSession: () => {
      issued++;
    },
    db,
  });
  const server = createServer((req, res) => {
    void oauth
      .handle(req, res, new URL(req.url!, "http://localhost"))
      .then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end();
        }
      });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function begin() {
    const response = await fetch(base + "/auth/yandex", { redirect: "manual" });
    assert.equal(response.status, 302);
    const target = new URL(response.headers.get("location")!);
    assert.equal(target.origin, "https://oauth.yandex.ru");
    assert.equal(target.searchParams.get("code_challenge_method"), "S256");
    challenge = target.searchParams.get("code_challenge")!;
    return {
      cookie: response.headers.get("set-cookie")!.split(";")[0],
      state: target.searchParams.get("state")!,
    };
  }
  try {
    const first = await begin();
    let response = await fetch(
      base + `/auth/yandex/callback?state=${first.state}&code=code`,
      { redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(tokenCalls, 0);
    response = await fetch(
      base + `/auth/yandex/callback?state=${first.state}&code=code`,
      { headers: { Cookie: first.cookie }, redirect: "manual" },
    );
    assert.equal(response.status, 303);
    assert.equal(issued, 1);
    response = await fetch(
      base + `/auth/yandex/callback?state=${first.state}&code=code`,
      { headers: { Cookie: first.cookie }, redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(tokenCalls, 1);
    const second = await begin();
    profileId = "stranger";
    response = await fetch(
      base + `/auth/yandex/callback?state=${second.state}&code=code`,
      { headers: { Cookie: second.cookie }, redirect: "manual" },
    );
    assert.equal(response.status, 303);
    assert.equal(issued, 2);
    const third = await begin();
    response = await fetch(
      base + `/auth/yandex/callback?state=${third.state}&error=access_denied`,
      { headers: { Cookie: third.cookie }, redirect: "manual" },
    );
    assert.equal(response.status, 400);
    assert.equal(tokenCalls, 2);
  } finally {
    server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  db.close();
  }
});
