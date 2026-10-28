import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  emailLoginNeedsCaptcha,
  EmailCaptchaUnavailable,
  verifyEmailCaptcha,
} from "../src/server/email-captcha.ts";
import { emailAuthHttp } from "../src/server/email-auth-http.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";

const origin = "https://drevo.example.org";
const configuration = {
  enabled: true,
  siteKey: "public-fixture",
  secret: "secret-fixture",
};

test("captcha validates server-side against the expected host and does not replay a token", async () => {
  const used = new Set<string>();
  const request: typeof fetch = async (url, options) => {
    assert.equal(url, "https://smartcaptcha.cloud.yandex.ru/validate");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    const body = options!.body as URLSearchParams;
    assert.equal(body.get("secret"), configuration.secret);
    assert.equal(body.get("ip"), "203.0.113.8");
    const token = body.get("token")!;
    const status = used.has(token) ? "failed" : "ok";
    used.add(token);
    return Response.json({
      status,
      host: token === "wrong-host" ? "other.example" : "drevo.example.org",
    });
  };
  assert.equal(
    await verifyEmailCaptcha(
      configuration,
      undefined,
      "203.0.113.8",
      origin,
      request,
    ),
    false,
  );
  assert.equal(
    await verifyEmailCaptcha(
      configuration,
      "a".repeat(4097),
      "203.0.113.8",
      origin,
      request,
    ),
    false,
  );
  assert.equal(
    await verifyEmailCaptcha(
      configuration,
      "good",
      "203.0.113.8",
      origin,
      request,
    ),
    true,
  );
  assert.equal(
    await verifyEmailCaptcha(
      configuration,
      "good",
      "203.0.113.8",
      origin,
      request,
    ),
    false,
  );
  assert.equal(
    await verifyEmailCaptcha(
      configuration,
      "wrong-host",
      "203.0.113.8",
      origin,
      request,
    ),
    false,
  );
});

test("captcha outages, malformed replies and empty host never bypass protection", async () => {
  for (const request of [
    async () => {
      throw new Error("network");
    },
    async () => new Response("unavailable", { status: 503 }),
    async () => new Response("not JSON"),
    async () => Response.json({ status: "ok", host: "" }),
    async () => Response.json(null),
    async () => Response.json({ status: "unexpected" }),
  ])
    await assert.rejects(
      verifyEmailCaptcha(
        configuration,
        "token",
        "203.0.113.8",
        origin,
        request,
      ),
      EmailCaptchaUnavailable,
    );
});

function database() {
  let passwordReads = 0;
  let loginAttempts = 0;
  const db = {
    kind: "postgres",
    postgresTransaction: async (work: (client: unknown) => Promise<unknown>) =>
      work({
        async query(sql: string) {
          if (sql.includes("INSERT INTO email_login_attempts"))
            return { rows: [{ attempts: ++loginAttempts }] };
          if (sql.includes("INSERT INTO email_auth_rate_limits"))
            return { rows: [{ attempts: 1 }] };
          if (sql.includes("SELECT account_id,password_hash")) passwordReads++;
          return { rows: [], rowCount: 0 };
        },
      }),
  } as unknown as StoreDatabase;
  return { db, reads: () => passwordReads };
}

async function post(
  handle: ReturnType<typeof emailAuthHttp>,
  path: string,
  body: Record<string, unknown>,
  requestOrigin = origin,
) {
  const req = Object.assign(
    Readable.from([Buffer.from(JSON.stringify(body))]),
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: requestOrigin },
      socket: { remoteAddress: "203.0.113.8" },
    },
  ) as unknown as IncomingMessage;
  let status = 0,
    payload = "";
  const res = {
    writeHead(code: number) {
      status = code;
    },
    end(value: string) {
      payload = value;
    },
  } as unknown as ServerResponse;
  await handle.handle(req, res, new URL(path, origin));
  return { status, body: JSON.parse(payload) };
}

test("registration and reset require captcha before database writes; ordinary login becomes protected after five attempts", async () => {
  const { db, reads } = database();
  const handle = emailAuthHttp(
    db,
    {} as Parameters<typeof emailAuthHttp>[1],
    origin,
    null,
    async () => ({
      enabled: true,
      sender: async () => {},
      captcha: configuration,
    }),
  );
  for (const path of ["register", "reset/request"])
    assert.deepEqual(
      await post(handle, `/api/auth/email/${path}`, {
        email: "person@example.org",
      }),
      {
        status: 403,
        body: {
          error: "Подтвердите, что вы не робот.",
          captchaRequired: true,
          siteKey: configuration.siteKey,
        },
      },
    );
  for (let attempt = 0; attempt < 5; attempt++)
    assert.equal(
      (
        await post(handle, "/api/auth/email/login", {
          email: `person${attempt}@example.org`,
          password: "incorrect password",
        })
      ).status,
      401,
    );
  assert.equal(reads(), 5);
  const sixth = await post(handle, "/api/auth/email/login", {
    email: "person6@example.org",
    password: "incorrect password",
  });
  assert.equal(sixth.status, 403);
  assert.equal(sixth.body.captchaRequired, true);
  assert.equal(
    reads(),
    5,
    "no expensive password verification before passing the challenge",
  );
  assert.ok(!JSON.stringify(sixth).includes(configuration.secret));
  assert.equal(
    (
      await post(
        handle,
        "/api/auth/email/register",
        {},
        "https://attacker.example",
      )
    ).status,
    403,
  );
});

test("login protection uses a shared atomic counter rather than per-handler state", async () => {
  const { db } = database();
  for (let index = 0; index < 5; index++)
    assert.equal(await emailLoginNeedsCaptcha(db, "203.0.113.8"), false);
  assert.equal(await emailLoginNeedsCaptcha(db, "203.0.113.8"), true);
});

test("a solved captcha cannot bypass hard request limits", async () => {
  const { db } = database();
  const handle = emailAuthHttp(
    db,
    {} as Parameters<typeof emailAuthHttp>[1],
    origin,
    null,
    async () => ({
      enabled: true,
      sender: async () => {},
      captcha: configuration,
    }),
  );
  let result;
  for (let i = 0; i < 9; i++)
    result = await post(handle, "/api/auth/email/register", {
      email: "same@example.org",
    });
  assert.equal(result!.status, 429);
  assert.equal(result!.body.captchaRequired, undefined);
});

test("HTTP verifies a challenge token and fails closed on provider outage", async (t) => {
  const { db, reads } = database();
  const handle = emailAuthHttp(
    db,
    {} as Parameters<typeof emailAuthHttp>[1],
    origin,
    null,
    async () => ({
      enabled: true,
      sender: async () => {},
      captcha: configuration,
    }),
  );
  for (let i = 0; i < 5; i++) await emailLoginNeedsCaptcha(db, "203.0.113.8");
  let available = true,
    validations = 0;
  t.mock.method(globalThis, "fetch", async () => {
    validations++;
    if (!available)
      throw new Error("provider transport details secret-fixture");
    return Response.json({ status: "ok", host: "drevo.example.org" });
  });
  const body = {
    email: "check@example.org",
    password: "incorrect password",
    captchaToken: "provider-token",
  };
  assert.equal((await post(handle, "/api/auth/email/login", body)).status, 401);
  assert.equal(reads(), 1);
  available = false;
  const failed = await post(handle, "/api/auth/email/login", body);
  assert.equal(failed.status, 503);
  assert.equal(reads(), 1);
  assert.equal(validations, 2);
  assert.ok(!JSON.stringify(failed).includes(configuration.secret));
});
