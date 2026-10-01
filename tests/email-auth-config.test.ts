import assert from "node:assert/strict";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { emailAuthHttp } from "../src/server/email-auth-http.ts";

test("email auth stays off until explicitly enabled and a sender is present", () => {
  const previous = process.env.EMAIL_AUTH_ENABLED;
  const smtpHost = process.env.SMTP_HOST;
  const smtpFrom = process.env.SMTP_FROM;
  const smtpUser = process.env.SMTP_USER;
  const smtpPassword = process.env.SMTP_PASSWORD;
  const db = {
    kind: "postgres",
    postgresTransaction: async () => undefined,
  } as unknown as Parameters<typeof emailAuthHttp>[0];
  const auth = {} as Parameters<typeof emailAuthHttp>[1];
  const sender = async () => {};
  try {
    delete process.env.EMAIL_AUTH_ENABLED;
    process.env.SMTP_HOST = "invalid host";
    process.env.SMTP_FROM = "mail@example.org";
    process.env.SMTP_USER = "user";
    process.env.SMTP_PASSWORD = "password";
    assert.equal(emailAuthHttp(db, auth, "https://example.org").enabled, false);
    assert.equal(
      emailAuthHttp(db, auth, "https://example.org", sender).enabled,
      false,
    );
    process.env.EMAIL_AUTH_ENABLED = "1";
    delete process.env.SMTP_HOST;
    assert.equal(emailAuthHttp(db, auth, "https://example.org").enabled, false);
    assert.equal(
      emailAuthHttp(db, auth, "https://example.org", null).enabled,
      false,
    );
    assert.equal(
      emailAuthHttp(db, auth, "https://example.org", sender).enabled,
      true,
    );
  } finally {
    for (const [key, value] of Object.entries({
      EMAIL_AUTH_ENABLED: previous,
      SMTP_HOST: smtpHost,
      SMTP_FROM: smtpFrom,
      SMTP_USER: smtpUser,
      SMTP_PASSWORD: smtpPassword,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("disabled email endpoint returns 503 without reading a registration request", async () => {
  const previous = process.env.EMAIL_AUTH_ENABLED;
  try {
    delete process.env.EMAIL_AUTH_ENABLED;
    const auth = emailAuthHttp(
      {} as Parameters<typeof emailAuthHttp>[0],
      {} as Parameters<typeof emailAuthHttp>[1],
    );
    let status = 0;
    let response = "";
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        response = value;
      },
    } as unknown as ServerResponse;
    assert.equal(
      await auth.handle(
        {} as IncomingMessage,
        res,
        new URL("https://example.org/api/auth/email/register"),
      ),
      true,
    );
    assert.equal(status, 503);
    assert.match(response, /не настроен/);
  } finally {
    if (previous === undefined) delete process.env.EMAIL_AUTH_ENABLED;
    else process.env.EMAIL_AUTH_ENABLED = previous;
  }
});
