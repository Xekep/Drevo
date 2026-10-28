import { createHash, randomInt } from "node:crypto";
import type { StoreDatabase } from "./store-database.ts";

export type EmailCaptchaConfiguration = {
  enabled: boolean;
  siteKey: string;
  secret: string;
};

export class EmailCaptchaUnavailable extends Error {}

/** Verify once, outside a DB transaction. Never accept an outage as a pass. */
export async function verifyEmailCaptcha(
  configuration: EmailCaptchaConfiguration,
  token: unknown,
  ip: string,
  origin: string,
  request: typeof fetch = fetch,
) {
  if (typeof token !== "string" || !token || token.length > 4096) return false;
  try {
    const response = await request(
      "https://smartcaptcha.cloud.yandex.ru/validate",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ secret: configuration.secret, token, ip }),
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (!response.ok) throw new Error();
    const result: unknown = await response.json();
    if (!result || typeof result !== "object") throw new Error();
    const { status, host } = result as { status?: unknown; host?: unknown };
    if (status === "failed") return false;
    if (status !== "ok" || typeof host !== "string" || !host) throw new Error();
    return host === new URL(origin).host;
  } catch {
    throw new EmailCaptchaUnavailable(
      "Проверка защиты временно недоступна. Попробуйте ещё раз.",
    );
  }
}

/** Count attempts across backend processes, without retaining the raw IP. */
export async function emailLoginNeedsCaptcha(
  db: StoreDatabase,
  ip: string,
  now = Date.now(),
) {
  return db.postgresTransaction!(async (client) => {
    if (randomInt(100) === 0)
      await client.query(
        `DELETE FROM email_login_attempts WHERE key_hash IN
        (SELECT key_hash FROM email_login_attempts WHERE started_at<$1 ORDER BY started_at LIMIT 100)`,
        [now - 24 * 60 * 60_000],
      );
    const result = await client.query<{ attempts: number }>(
      `INSERT INTO email_login_attempts(key_hash,started_at,attempts) VALUES($1,$2,1)
       ON CONFLICT(key_hash) DO UPDATE SET
         started_at=CASE WHEN email_login_attempts.started_at<=$3 THEN $2 ELSE email_login_attempts.started_at END,
         attempts=CASE WHEN email_login_attempts.started_at<=$3 THEN 1 ELSE LEAST(email_login_attempts.attempts+1,1000) END
       RETURNING attempts`,
      [createHash("sha256").update(ip).digest("hex"), now, now - 10 * 60_000],
    );
    return result.rows[0].attempts > 5;
  });
}
