import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fixture } from "./postgres-fixture.ts";
import { emailLoginNeedsCaptcha } from "../../src/server/email-captcha.ts";
import {
  emailCredentials,
  InvalidEmailCredential,
} from "../../src/server/email-credentials.ts";
import { issuePostgresSessionInTransaction } from "../../src/server/postgres-sessions.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";

test("email registration, expiry, reset revocation and shared captcha counter use real PostgreSQL", async (t) => {
  const { first, second } = await fixture(t);
  for (const file of [
    "007_account_identities.sql",
    "033_email_accounts.sql",
    "035_pending_email_links.sql",
    "095_platform_email_auth.sql",
    "109_email_smartcaptcha.sql",
    "109_email_smartcaptcha.sql",
  ])
    await first.query(
      readFileSync(
        new URL(`../../ops/postgres/${file}`, import.meta.url),
        "utf8",
      ),
    );
  const db = {
    kind: "postgres",
    postgresTransaction: async (
      work: (client: unknown) => Promise<unknown>,
    ) => {
      await first.query("BEGIN");
      try {
        const result = await work(first);
        await first.query("COMMIT");
        return result;
      } catch (error) {
        await first.query("ROLLBACK");
        throw error;
      }
    },
  } as unknown as StoreDatabase;
  let clock = Date.now();
  const letters: string[] = [];
  const credentials = emailCredentials(
    db,
    async (_to, _subject, text) => {
      letters.push(text);
    },
    "https://drevo.example.org",
    () => clock,
  );
  const token = (kind: "verify" | "reset") => {
    const value = letters
      .at(-1)
      ?.match(new RegExp(`#email-${kind}=([A-Za-z0-9_-]{43})`))?.[1];
    assert.ok(value);
    return value;
  };
  await credentials.requestRegistration({
    email: " New@Example.org ",
    name: "Участник",
    password: "a secure original password",
  });
  const expired = token("verify");
  assert.equal(
    (
      await first.query(
        "SELECT count(*)::int AS n FROM account_email_credentials",
      )
    ).rows[0].n,
    0,
  );
  clock += 24 * 60 * 60_000;
  await assert.rejects(
    credentials.verifyRegistration(expired),
    InvalidEmailCredential,
  );
  await credentials.requestRegistration({
    email: "new@example.org",
    name: "Участник",
    password: "a secure original password",
  });
  const confirmation = token("verify");
  const account = await credentials.verifyRegistration(confirmation);
  await assert.rejects(
    credentials.verifyRegistration(confirmation),
    InvalidEmailCredential,
  );
  assert.equal(
    (
      await credentials.login({
        email: "NEW@example.org",
        password: "a secure original password",
      })
    ).accountId,
    account.accountId,
  );
  const session = await db.postgresTransaction!((client) =>
    issuePostgresSessionInTransaction(client, account.accountId),
  );
  assert.ok(session.token);
  await credentials.requestReset("new@example.org");
  const expiredReset = token("reset");
  clock += 30 * 60_000;
  await assert.rejects(
    credentials.resetPassword(expiredReset, "a secure replacement password"),
    InvalidEmailCredential,
  );
  await credentials.requestReset("new@example.org");
  const reset = token("reset");
  await credentials.resetPassword(reset, "a secure replacement password");
  await assert.rejects(
    credentials.resetPassword(reset, "another secure replacement"),
    InvalidEmailCredential,
  );
  await assert.rejects(
    credentials.login({
      email: "new@example.org",
      password: "a secure original password",
    }),
    InvalidEmailCredential,
  );
  assert.equal(
    (
      await credentials.login({
        email: "new@example.org",
        password: "a secure replacement password",
      })
    ).accountId,
    account.accountId,
  );
  assert.equal(
    (
      await first.query(
        "SELECT count(*)::int AS n FROM account_sessions WHERE user_id=$1",
        [account.accountId],
      )
    ).rows[0].n,
    0,
  );
  // Separate connections and concurrent increments: never lose attempts.
  const counters = [first, second].map(
    (client) =>
      ({
        postgresTransaction: async (
          work: (connection: unknown) => Promise<unknown>,
        ) => work(client),
      }) as StoreDatabase,
  );
  const protection = await Promise.all(
    counters.map(async (counter) => {
      const results: boolean[] = [];
      for (let i = 0; i < 4; i++)
        results.push(
          await emailLoginNeedsCaptcha(counter, "203.0.113.8", clock),
        );
      return results;
    }),
  );
  assert.equal(protection.flat().filter(Boolean).length, 3);
  assert.equal(
    await emailLoginNeedsCaptcha(
      counters[1],
      "203.0.113.8",
      clock + 10 * 60_000,
    ),
    false,
  );
  assert.equal(
    await emailLoginNeedsCaptcha(counters[0], "203.0.113.9", clock),
    false,
  );
  const rows = (
    await first.query("SELECT key_hash,attempts FROM email_login_attempts")
  ).rows;
  assert.ok(rows.every((row) => /^[a-f0-9]{64}$/.test(row.key_hash)));
});
