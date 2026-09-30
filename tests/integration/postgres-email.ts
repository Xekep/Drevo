import assert from "node:assert/strict";
import type pg from "pg";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { accountArchiveDirectory } from "../../src/server/account-archives.ts";
import {
  emailCredentials,
  InvalidEmailCredential,
} from "../../src/server/email-credentials.ts";

export async function verifyEmailAccounts(
  db: StoreDatabase,
  client: pg.Client,
) {
  const sent: { to: string; text: string }[] = [];
  const accounts = emailCredentials(
    db,
    async (to, _subject, text) => {
      sent.push({ to, text });
    },
    "https://mydrevo.org",
  );
  await accounts.requestRegistration({
    email: " New.Person@Example.org ",
    name: "Новый участник",
    password: "correct horse battery staple",
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "new.person@example.org");
  const verifyToken = sent[0].text.match(
    /#email-verify=([A-Za-z0-9_-]{43})/,
  )?.[1];
  assert.ok(verifyToken);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM account_email_credentials WHERE email='new.person@example.org'",
      )
    ).rows[0].n,
    0,
    "an unverified registration must not create an account",
  );
  const account = await accounts.verifyRegistration(verifyToken);
  assert.notEqual(account.archiveId, "runtime-test");
  assert.equal(
    (
      await accounts.login({
        email: "new.person@example.org",
        password: "correct horse battery staple",
      })
    ).archiveId,
    account.archiveId,
  );
  await assert.rejects(
    accounts.verifyRegistration(verifyToken),
    InvalidEmailCredential,
  );
  await assert.rejects(
    accounts.login({
      email: "new.person@example.org",
      password: "wrong password",
    }),
    InvalidEmailCredential,
  );
  await accounts.requestRegistration({
    email: "new.person@example.org",
    name: "Other",
    password: "another secure password",
  });
  assert.equal(
    sent.length,
    1,
    "a duplicate email must not create a second archive",
  );
  await accounts.requestReset("new.person@example.org");
  const resetToken = sent[1].text.match(
    /#email-reset=([A-Za-z0-9_-]{43})/,
  )?.[1];
  assert.ok(resetToken);
  await accounts.resetPassword(resetToken, "a new long safe password");
  await assert.rejects(
    accounts.resetPassword(resetToken, "yet another safe password"),
    InvalidEmailCredential,
  );
  await assert.rejects(
    accounts.login({
      email: "new.person@example.org",
      password: "correct horse battery staple",
    }),
    InvalidEmailCredential,
  );
  assert.equal(
    (
      await accounts.login({
        email: "new.person@example.org",
        password: "a new long safe password",
      })
    ).accountId,
    account.accountId,
  );
  assert.deepEqual(
    (await accountArchiveDirectory(db).list(account.accountId))?.map(
      (row) => row.id,
    ),
    [account.archiveId],
  );
}
