import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { adminEmailAuthHttp } from "../src/server/admin-email-auth-http.ts";
import { emailAuthHttp } from "../src/server/email-auth-http.ts";
import { emailAuthSettingsStore } from "../src/server/email-auth-settings.ts";
import { validSmtpConfiguration } from "../src/server/email-sender.ts";
import { PlatformAccessDenied } from "../src/server/platform-access.ts";
import { encryptAiSecret } from "../src/server/ai-secret.ts";

const origin = "https://drevo.example.org";
const session = { accountId: "platform-owner", tokenHash: "fixture" };
const configuration = { enabled: true, host: "smtp.example.org", port: 587,
  user: "smtp-user", from: "mail@example.org", password: "fixture-password" };

async function request(handle: ReturnType<typeof adminEmailAuthHttp>, method: string,
  path: string, body: unknown = {}, headers: Record<string, string> = {}) {
  const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method, headers: { "content-type": "application/json", origin, ...headers },
  }) as IncomingMessage;
  let status = 0, value = "";
  const res = { writeHead(code: number, responseHeaders: Record<string, string>) {
    status = code; assert.equal(responseHeaders["Cache-Control"], "no-store");
  }, end(text: string) { value = text; } } as unknown as ServerResponse;
  await handle(req, res, new URL(path, origin));
  return { status, body: JSON.parse(value) };
}

test("SMTP accepts TLS ports and rejects incomplete or header-breaking configuration", () => {
  assert.equal(validSmtpConfiguration(configuration), true);
  assert.equal(validSmtpConfiguration({ ...configuration, port: 465 }), true);
  for (const invalid of [{ host: "invalid host" }, { port: 0 }, { port: 65536 },
    { port: 1.5 }, { password: "" }, { user: "name\r\nvalue" }, { from: "Name <mail@example.org>" }])
    assert.equal(validSmtpConfiguration({ ...configuration, ...invalid }), false);
});

test("email admin denies guests, tree owners and cross-origin writes before side effects", async () => {
  let authenticated = false, admin = false, calls = 0;
  const auth = { accountSession: async () => authenticated ? session : null,
    isPlatformAdmin: async () => admin } as unknown as Parameters<typeof adminEmailAuthHttp>[0];
  const settings = { read: async () => { calls++; return {}; },
    write: async () => { calls++; return {}; } } as unknown as Parameters<typeof adminEmailAuthHttp>[1];
  const handle = adminEmailAuthHttp(auth, settings, origin);
  assert.equal((await request(handle, "GET", "/api/admin/auth/email")).status, 401);
  authenticated = true;
  assert.equal((await request(handle, "PUT", "/api/admin/auth/email", configuration)).status, 403);
  admin = true;
  assert.equal((await request(handle, "PUT", "/api/admin/auth/email", configuration, { origin: "https://foreign.invalid" })).status, 403);
  assert.equal((await request(handle, "POST", "/api/admin/auth/email")).status, 405);
  assert.equal(calls, 0);
});

test("test emails use saved settings, have bounded attempts and hide transport secrets", async () => {
  const sent: string[] = [];
  let fail = false, revoked = false;
  const auth = { accountSession: async () => session, isPlatformAdmin: async () => true } as unknown as Parameters<typeof adminEmailAuthHttp>[0];
  const settings = { testSender: async () => {
    if (revoked) throw new PlatformAccessDenied();
    return async (to: string) => { if (fail) throw new Error("smtp-password-and-provider-details"); sent.push(to); };
  } } as unknown as Parameters<typeof adminEmailAuthHttp>[1];
  const handle = adminEmailAuthHttp(auth, settings, origin);
  assert.equal((await request(handle, "POST", "/api/admin/auth/email/test", { to: "bad\r\naddress" })).status, 400);
  const good = await request(handle, "POST", "/api/admin/auth/email/test", { to: "test@example.org" });
  assert.equal(good.status, 200);
  assert.match(good.body.message, /SMTP принял/);
  fail = true;
  const failure = await request(handle, "POST", "/api/admin/auth/email/test", { to: "test@example.org" });
  assert.equal(failure.status, 502);
  assert.ok(!JSON.stringify(failure.body).includes("smtp-password"));
  fail = false; revoked = true;
  assert.equal((await request(handle, "POST", "/api/admin/auth/email/test", { to: "test@example.org" })).status, 403);
  assert.equal((await request(handle, "POST", "/api/admin/auth/email/test", { to: "test@example.org" })).status, 429);
  assert.deepEqual(sent, ["test@example.org"]);
});

test("email availability follows runtime settings without recreating the HTTP handler", async () => {
  let enabled = false;
  const db = { kind: "postgres", postgresTransaction: async () => {} } as unknown as Parameters<typeof emailAuthHttp>[0];
  const handler = emailAuthHttp(db, {} as Parameters<typeof emailAuthHttp>[1], origin, null,
    async () => ({ enabled, sender: async () => {} }));
  assert.equal(await handler.isEnabled(), false);
  enabled = true;
  assert.equal(await handler.isEnabled(), true);
  enabled = false;
  assert.equal(await handler.isEnabled(), false);
  const req = {} as IncomingMessage;
  let status = 0;
  const res = { writeHead(code: number) { status = code; }, end() {} } as unknown as ServerResponse;
  assert.equal(await handler.handle(req, res, new URL("/api/auth/email/login", origin)), true);
  assert.equal(status, 503);
});

test("email settings redact persisted credentials and fail closed if encryption key is unavailable", async () => {
  const db = { kind: "postgres", file: "", postgresTransaction: async () => {},
    prepare: () => ({ get: async () => ({ enabled: true, host: configuration.host, port: 587,
      smtp_user: configuration.user, sender: configuration.from,
      password_cipher: "v1.unreadable.auth.secret" }) }) } as unknown as Parameters<typeof emailAuthSettingsStore>[0];
  const settings = emailAuthSettingsStore(db, origin);
  const status = await settings.read();
  assert.equal(status.hasPassword, false);
  assert.equal(status.available, false);
  assert.ok(!JSON.stringify(status).includes("password_cipher"));
  assert.deepEqual(await settings.runtime(), { enabled: false, sender: null });
});

test("SmartCaptcha settings preserve and redact secrets, validate enabling and honor removal", async () => {
  let row: Record<string, unknown>;
  const db = { kind: "postgres", file: "",
    prepare: () => ({ get: async () => row }),
    postgresTransaction: async (work: (client: unknown) => Promise<unknown>) => work({
      async query(sql: string, values: unknown[] = []) {
        if (sql.startsWith("SELECT id FROM accounts")) return { rowCount: 1, rows: [{ id: session.accountId }] };
        if (sql.includes("SELECT expires_at FROM account_sessions")) return { rowCount: 1, rows: [{ expires_at: Date.now() + 60_000 }] };
        if (sql.startsWith("SELECT account_id FROM platform_admins")) return { rowCount: 1, rows: [{ account_id: session.accountId }] };
        if (sql.startsWith("SELECT * FROM platform_email_auth_settings")) return { rows: [row] };
        if (sql.startsWith("INSERT INTO platform_email_auth_settings")) {
          const [enabled, host, port, smtp_user, sender, password_cipher, captcha_enabled, captcha_site_key, captcha_secret_cipher] = values;
          row = { enabled, host, port, smtp_user, sender, password_cipher, captcha_enabled, captcha_site_key, captcha_secret_cipher };
        }
        return { rows: [], rowCount: 0 };
      },
    }),
  } as unknown as Parameters<typeof emailAuthSettingsStore>[0];
  row = { enabled: true, host: configuration.host, port: 587, smtp_user: configuration.user,
    sender: configuration.from, password_cipher: encryptAiSecret(db, "smtp-secret"), captcha_enabled: false,
    captcha_site_key: "", captcha_secret_cipher: "" };
  const settings = emailAuthSettingsStore(db, origin);
  const update = { enabled: true, host: configuration.host, port: 587, user: configuration.user, from: configuration.from };
  await assert.rejects(settings.write({ ...update, captcha: { enabled: true, siteKey: "public" } }, session), /оба ключа/);
  const enabled = await settings.write({ ...update, captcha: { enabled: true, siteKey: "public", secret: "captcha-secret" } }, session);
  assert.deepEqual(enabled.captcha, { enabled: true, siteKey: "public", hasSecret: true });
  assert.ok(!JSON.stringify(enabled).includes("captcha-secret"));
  assert.notEqual(row.captcha_secret_cipher, "captcha-secret");
  const cipher = row.captcha_secret_cipher;
  await settings.write({ ...update, captcha: { enabled: true, siteKey: "public" } }, session);
  assert.equal(row.captcha_secret_cipher, cipher);
  const runtime = await settings.runtime();
  assert.equal(runtime.enabled, true);
  assert.ok("captcha" in runtime);
  assert.equal(runtime.captcha?.secret, "captcha-secret");
  row.captcha_secret_cipher = "v1.unreadable.captcha.secret";
  assert.equal((await settings.read()).available, false);
  assert.deepEqual(await settings.runtime(), { enabled: false, sender: null });
  const removed = await settings.write({ ...update, captcha: { enabled: false, siteKey: "public", secret: null } }, session);
  assert.equal(removed.captcha?.hasSecret, false);
  assert.equal((await settings.runtime()).enabled, true);
});
