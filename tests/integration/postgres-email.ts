import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { accountArchiveDirectory } from "../../src/server/account-archives.ts";
import {
  emailCredentials,
  InvalidEmailCredential,
  StaleEmailSession,
  StaleOAuthSession,
} from "../../src/server/email-credentials.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";
import { postgresEmailRateLimit } from "../../src/server/postgres-email-rate-limit.ts";
import {
  issuePostgresEmailSessionInTransaction,
  issuePostgresSessionInTransaction,
} from "../../src/server/postgres-sessions.ts";
import { emailAuthHttp } from "../../src/server/email-auth-http.ts";

export async function verifyEmailAccounts(
  db: StoreDatabase,
  client: pg.Client,
) {
  let clock = Date.now();
  const firstLimit = postgresEmailRateLimit(db, () => clock);
  const secondLimit = postgresEmailRateLimit(db, () => clock);
  for (let attempt = 0; attempt < 8; attempt++)
    assert.equal(
      await firstLimit.allow("203.0.113.7", "limit@example.org"),
      true,
    );
  assert.equal(
    await secondLimit.allow("203.0.113.7", "limit@example.org"),
    false,
    "a second process must see the same email limit",
  );
  clock += 10 * 60 * 1000 + 1;
  assert.equal(
    await secondLimit.allow("203.0.113.7", "limit@example.org"),
    true,
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM email_auth_rate_limits WHERE key_hash='limit@example.org'",
      )
    ).rows[0].n,
    0,
  );
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
  const checkedBeforeReset = await accounts.login({
    email: "new.person@example.org",
    password: "correct horse battery staple",
  });
  const resetToken = sent[1].text.match(
    /#email-reset=([A-Za-z0-9_-]{43})/,
  )?.[1];
  assert.ok(resetToken);
  await accounts.resetPassword(resetToken, "a new long safe password");
  await assert.rejects(
    db.postgresTransaction!((transaction) =>
      issuePostgresEmailSessionInTransaction(
        transaction,
        checkedBeforeReset.accountId,
        checkedBeforeReset.passwordHash,
      ),
    ),
    InvalidEmailCredential,
    "a login checked before reset cannot issue a session after reset",
  );
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
  const oauthSession = sessionTokenHash(newSessionToken());
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [oauthSession, Date.now() + 60 * 60 * 1000],
  );
  await assert.rejects(
    accounts.requestLink(
      "owner",
      {
        email: "unverified-link@example.org",
        password: "a separate strong password",
      },
      oauthSession,
    ),
    StaleOAuthSession,
    "an ordinary session without fresh OAuth proof cannot link email",
  );
  await client.query(
    "INSERT INTO account_oauth_session_proofs(token_hash,provider,authenticated_at) VALUES($1,'yandex',$2)",
    [oauthSession, Date.now() - 11 * 60 * 1000],
  );
  await assert.rejects(
    accounts.requestLink(
      "owner",
      {
        email: "unverified-link@example.org",
        password: "a separate strong password",
      },
      oauthSession,
    ),
    StaleOAuthSession,
    "a session older than ten minutes cannot link email",
  );
  await client.query(
    "UPDATE account_oauth_session_proofs SET authenticated_at=$2 WHERE token_hash=$1",
    [oauthSession, Date.now()],
  );
  await assert.rejects(
    accounts.requestLink(
      "owner",
      {
        email: "unverified-link@example.org",
        password: "a separate strong password",
      },
      sessionTokenHash(newSessionToken()),
    ),
    StaleOAuthSession,
    "a revoked or unrelated OAuth session cannot request an email link",
  );
  await accounts.requestLink(
    "owner",
    {
      email: "linked@example.org",
      password: "a separate strong password",
    },
    oauthSession,
  );
  const linkToken = sent[2].text.match(/#email-link=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(linkToken);
  await assert.rejects(
    accounts.verifyLink(account.accountId, linkToken, oauthSession),
    StaleOAuthSession,
    "the verified mailbox alone cannot attach a login to another account",
  );
  await client.query("DELETE FROM account_sessions WHERE token_hash=$1", [
    oauthSession,
  ]);
  await assert.rejects(
    accounts.verifyLink("owner", linkToken, oauthSession),
    StaleOAuthSession,
    "revoking the OAuth session after the HTTP check must block completion",
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM account_email_credentials WHERE email='linked@example.org'",
      )
    ).rows[0].n,
    0,
  );
  const renewedOAuthSession = sessionTokenHash(newSessionToken());
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'owner',$2)",
    [renewedOAuthSession, Date.now() + 60 * 60 * 1000],
  );
  await client.query(
    "INSERT INTO account_oauth_session_proofs(token_hash,provider,authenticated_at) VALUES($1,'yandex',$2)",
    [renewedOAuthSession, Date.now()],
  );
  let releaseLink!: () => void;
  let linkLocked!: () => void;
  const heldLink = new Promise<void>((resolve) => {
    releaseLink = resolve;
  });
  const acquiredLinkLock = new Promise<void>((resolve) => {
    linkLocked = resolve;
  });
  const blockingDb: StoreDatabase = {
    ...db,
    postgresTransaction: <T>(
      work: (transaction: pg.PoolClient) => Promise<T>,
    ) =>
      db.postgresTransaction!(async (transaction) => {
        const guarded = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property !== "query")
              return Reflect.get(target, property, receiver);
            return (async (sql: string, params?: unknown[]) => {
              const result = await target.query(sql, params);
              if (sql.includes("FOR SHARE OF s,p")) {
                linkLocked();
                await heldLink;
              }
              return result;
            }) as pg.PoolClient["query"];
          },
        });
        return work(guarded);
      }),
  };
  const blockingAccounts = emailCredentials(
    blockingDb,
    async () => {},
    "https://mydrevo.org",
  );
  const completingLink = blockingAccounts.verifyLink(
    "owner",
    linkToken,
    renewedOAuthSession,
  );
  let lockTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      acquiredLinkLock,
      completingLink.then(() => {
        throw new Error("Link completed before holding the OAuth session lock");
      }),
      new Promise<never>((_, reject) => {
        lockTimeout = setTimeout(
          () =>
            reject(new Error("Timed out waiting for the OAuth session lock")),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    releaseLink();
    throw error;
  } finally {
    if (lockTimeout) clearTimeout(lockTimeout);
  }
  const revokingSession = client.query(
    "DELETE FROM account_sessions WHERE token_hash=$1",
    [renewedOAuthSession],
  );
  try {
    assert.equal(
      await Promise.race([
        revokingSession.then(() => "revoked"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("waiting"), 75),
        ),
      ]),
      "waiting",
      "revocation must wait for the in-flight credential transaction",
    );
  } finally {
    releaseLink();
  }
  await completingLink;
  await revokingSession;
  assert.equal(
    (
      await accounts.login({
        email: "linked@example.org",
        password: "a separate strong password",
      })
    ).archiveId,
    "runtime-test",
  );
  await assert.rejects(
    accounts.verifyLink("owner", linkToken, renewedOAuthSession),
    StaleOAuthSession,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT provider FROM account_identities WHERE account_id='owner' AND provider IN ('email','yandex') ORDER BY provider",
      )
    ).rows.map((row) => row.provider),
    ["email", "yandex"],
  );

  // A second link request must not send a confirmation that can never work
  // after another address has just been attached to this account.
  await client.query(
    "INSERT INTO accounts(id,name,created_at) VALUES('email-link-race','Email link race',$1)",
    [new Date().toISOString()],
  );
  const linkRaceSession = sessionTokenHash(newSessionToken());
  await client.query(
    "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES($1,'email-link-race',$2)",
    [linkRaceSession, Date.now() + 60 * 60 * 1000],
  );
  await client.query(
    "INSERT INTO account_oauth_session_proofs(token_hash,provider,authenticated_at) VALUES($1,'yandex',$2)",
    [linkRaceSession, Date.now()],
  );
  const linkRaceSent: string[] = [];
  const raceBase = emailCredentials(
    db,
    async (_to, _subject, text) => {
      linkRaceSent.push(text);
    },
    "https://mydrevo.org",
  );
  await raceBase.requestLink(
    "email-link-race",
    { email: "first-link@example.org", password: "first strong password" },
    linkRaceSession,
  );
  const firstLinkToken = linkRaceSent[0]?.match(
    /#email-link=([A-Za-z0-9_-]{43})/,
  )?.[1];
  assert.ok(firstLinkToken);
  let releaseVerifiedRow!: () => void;
  let verifiedRowLocked!: () => void;
  const holdVerifiedRow = new Promise<void>((resolve) => {
    releaseVerifiedRow = resolve;
  });
  const verifiedRow = new Promise<void>((resolve) => {
    verifiedRowLocked = resolve;
  });
  const heldDb: StoreDatabase = {
    ...db,
    postgresTransaction: <T>(
      work: (transaction: pg.PoolClient) => Promise<T>,
    ) =>
      db.postgresTransaction!(async (transaction) => {
        const guarded = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property !== "query")
              return Reflect.get(target, property, receiver);
            return (async (sql: string, params?: unknown[]) => {
              const result = await target.query(sql, params);
              if (
                sql.includes(
                  "FROM pending_email_links WHERE account_id=$1 AND token_hash=$2 FOR UPDATE",
                )
              ) {
                verifiedRowLocked();
                await holdVerifiedRow;
              }
              return result;
            }) as pg.PoolClient["query"];
          },
        });
        return work(guarded);
      }),
  };
  const completingFirstLink = emailCredentials(
    heldDb,
    async () => {},
    "https://mydrevo.org",
  ).verifyLink("email-link-race", firstLinkToken, linkRaceSession);
  await verifiedRow;
  let secondCheckedCredential!: () => void;
  const secondCredentialCheck = new Promise<void>((resolve) => {
    secondCheckedCredential = resolve;
  });
  const observingDb: StoreDatabase = {
    ...db,
    postgresTransaction: <T>(
      work: (transaction: pg.PoolClient) => Promise<T>,
    ) =>
      db.postgresTransaction!(async (transaction) => {
        const guarded = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property !== "query")
              return Reflect.get(target, property, receiver);
            return (async (sql: string, params?: unknown[]) => {
              const result = await target.query(sql, params);
              if (
                sql.includes(
                  "SELECT 1 FROM account_email_credentials WHERE account_id=$1",
                )
              )
                secondCheckedCredential();
              return result;
            }) as pg.PoolClient["query"];
          },
        });
        return work(guarded);
      }),
  };
  const secondLink = emailCredentials(
    observingDb,
    async (_to, _subject, text) => {
      linkRaceSent.push(text);
    },
    "https://mydrevo.org",
  ).requestLink(
    "email-link-race",
    { email: "second-link@example.org", password: "second strong password" },
    linkRaceSession,
  );
  try {
    await Promise.race([
      secondCredentialCheck,
      new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
    ]);
  } finally {
    releaseVerifiedRow();
  }
  await completingFirstLink;
  await assert.rejects(secondLink, InvalidEmailCredential);
  assert.equal(
    linkRaceSent.length,
    1,
    "a stale second email link must not be sent",
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM pending_email_links WHERE account_id='email-link-race'",
      )
    ).rows[0].n,
    0,
  );

  let raceClock = Date.now();
  const raceAccounts = emailCredentials(
    db,
    async (to, _subject, text) => {
      sent.push({ to, text });
    },
    "https://mydrevo.org",
    () => raceClock,
  );
  await raceAccounts.requestRegistration({
    email: "race@example.org",
    name: "Concurrent registration",
    password: "a sufficiently long password",
  });
  const raceToken = sent
    .at(-1)
    ?.text.match(/#email-verify=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(raceToken);
  raceClock += 61_000;
  const concurrent = await Promise.allSettled([
    raceAccounts.verifyRegistration(raceToken),
    raceAccounts.requestRegistration({
      email: "race@example.org",
      name: "Concurrent registration",
      password: "a sufficiently long password",
    }),
  ]);
  for (const result of concurrent) {
    if (result.status === "rejected")
      assert.ok(
        result.reason instanceof InvalidEmailCredential,
        "concurrent verification and resend must not deadlock",
      );
  }

  // Losing ownership must not lock the verified account out of email login.
  // An invitation is usable only after approval; without any tree the account
  // session still opens /account, where a new personal tree can be created.
  await client.query(
    `INSERT INTO archive_memberships(archive_id,user_id,role,approved,person_id,tree_access)
     VALUES('runtime-test',$1,'reader',false,NULL,'all')`,
    [account.accountId],
  );
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
      account.archiveId,
    ]);
    const deleted = await client.query("DELETE FROM archives WHERE id=$1", [
      account.archiveId,
    ]);
    assert.equal(deleted.rowCount, 1);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
  const withoutTree = await accounts.login({
    email: "new.person@example.org",
    password: "a new long safe password",
  });
  assert.equal(withoutTree.archiveId, null);
  const previousFlag = process.env.EMAIL_AUTH_ENABLED;
  process.env.EMAIL_AUTH_ENABLED = "1";
  try {
    let issued = false;
    const endpoint = emailAuthHttp(
      db,
      {
        issueAccountSession: async (
          _req: IncomingMessage,
          _res: ServerResponse,
          accountId: string,
          passwordHash?: string,
        ) => {
          assert.equal(accountId, withoutTree.accountId);
          assert.equal(passwordHash, withoutTree.passwordHash);
          assert.ok(passwordHash);
          await db.postgresTransaction!((transaction) =>
            issuePostgresEmailSessionInTransaction(
              transaction,
              accountId,
              passwordHash,
            ),
          );
          issued = true;
        },
      } as unknown as Parameters<typeof emailAuthHttp>[1],
      "https://mydrevo.org",
      async () => {},
    );
    const body = Buffer.from(
      JSON.stringify({
        email: "new.person@example.org",
        password: "a new long safe password",
      }),
    );
    const request = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://mydrevo.org",
      },
      socket: { remoteAddress: "127.0.0.1" },
      async *[Symbol.asyncIterator]() {
        yield body;
      },
    } as unknown as IncomingMessage;
    let status = 0;
    let payload = "";
    const response = {
      writeHead(code: number) {
        status = code;
      },
      end(value: string) {
        payload = value;
      },
    } as unknown as ServerResponse;
    assert.equal(
      await endpoint.handle(
        request,
        response,
        new URL("https://mydrevo.org/api/auth/email/login"),
      ),
      true,
    );
    assert.equal(status, 200);
    assert.deepEqual(JSON.parse(payload), { archiveId: null, account: true });
    assert.equal(issued, true);
  } finally {
    if (previousFlag === undefined) delete process.env.EMAIL_AUTH_ENABLED;
    else process.env.EMAIL_AUTH_ENABLED = previousFlag;
  }
  await client.query(
    "UPDATE archive_memberships SET approved=true WHERE archive_id='runtime-test' AND user_id=$1",
    [account.accountId],
  );
  assert.equal(
    (
      await accounts.login({
        email: "new.person@example.org",
        password: "a new long safe password",
      })
    ).archiveId,
    "runtime-test",
  );

  const currentSession = await db.postgresTransaction!((transaction) =>
    issuePostgresSessionInTransaction(transaction, account.accountId),
  );
  const otherSession = await db.postgresTransaction!((transaction) =>
    issuePostgresSessionInTransaction(transaction, account.accountId),
  );
  const currentHash = sessionTokenHash(currentSession.token);
  const otherHash = sessionTokenHash(otherSession.token);
  await assert.rejects(
    accounts.changePassword(
      account.accountId,
      currentHash,
      "wrong password",
      "changed strong password one",
    ),
    InvalidEmailCredential,
  );
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM account_sessions WHERE token_hash IN ($1,$2)",
        [currentHash, otherHash],
      )
    ).rows[0].n,
    2,
    "a wrong current password cannot revoke sessions",
  );
  await accounts.requestReset("new.person@example.org");
  const oldResetToken = sent
    .at(-1)
    ?.text.match(/#email-reset=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(oldResetToken);
  const checkedBeforeChange = await accounts.login({
    email: "new.person@example.org",
    password: "a new long safe password",
  });
  const expectedRevoked = Number(
    (
      await client.query(
        "SELECT count(*)::int AS n FROM account_sessions WHERE user_id=$1 AND token_hash<>$2",
        [account.accountId, currentHash],
      )
    ).rows[0].n,
  );
  assert.ok(expectedRevoked >= 1);
  assert.equal(
    await accounts.changePassword(
      account.accountId,
      currentHash,
      "a new long safe password",
      "changed strong password one",
    ),
    expectedRevoked,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT token_hash FROM account_sessions WHERE token_hash IN ($1,$2)",
        [currentHash, otherHash],
      )
    ).rows.map((row) => row.token_hash),
    [currentHash],
    "the submitting session survives and all others are revoked",
  );
  await assert.rejects(
    accounts.resetPassword(oldResetToken, "reset old password again"),
    InvalidEmailCredential,
    "a pending recovery link cannot undo an authenticated password change",
  );
  await assert.rejects(
    db.postgresTransaction!((transaction) =>
      issuePostgresEmailSessionInTransaction(
        transaction,
        checkedBeforeChange.accountId,
        checkedBeforeChange.passwordHash,
      ),
    ),
    InvalidEmailCredential,
    "a login checked before the change cannot issue a late session",
  );
  await assert.rejects(
    accounts.login({
      email: "new.person@example.org",
      password: "a new long safe password",
    }),
    InvalidEmailCredential,
  );
  assert.equal(
    (
      await accounts.login({
        email: "new.person@example.org",
        password: "changed strong password one",
      })
    ).accountId,
    account.accountId,
  );
  await assert.rejects(
    accounts.changePassword(
      account.accountId,
      otherHash,
      "changed strong password one",
      "changed strong password two",
    ),
    StaleEmailSession,
    "a revoked session cannot change the password",
  );
  const storedHash = (
    await client.query(
      "SELECT password_hash FROM account_email_credentials WHERE account_id=$1",
      [account.accountId],
    )
  ).rows[0].password_hash;
  assert.ok(!storedHash.includes("changed strong password one"));

  await accounts.requestReset("new.person@example.org");
  const racingResetToken = sent
    .at(-1)
    ?.text.match(/#email-reset=([A-Za-z0-9_-]{43})/)?.[1];
  assert.ok(racingResetToken);
  const racingLogin = await accounts.login({
    email: "new.person@example.org",
    password: "changed strong password one",
  });
  let releaseChange!: () => void;
  let changeLocked!: (pid: number) => void;
  const heldChange = new Promise<void>((resolve) => {
    releaseChange = resolve;
  });
  const acquiredChangeLock = new Promise<number>((resolve) => {
    changeLocked = resolve;
  });
  const heldChangeDb: StoreDatabase = {
    ...db,
    postgresTransaction: <T>(
      work: (transaction: pg.PoolClient) => Promise<T>,
    ) =>
      db.postgresTransaction!(async (transaction) => {
        const guarded = new Proxy(transaction, {
          get(target, property, receiver) {
            if (property !== "query")
              return Reflect.get(target, property, receiver);
            return (async (sql: string, params?: unknown[]) => {
              const result = await target.query(sql, params);
              if (
                sql.startsWith(
                  "UPDATE account_email_credentials SET password_hash",
                )
              ) {
                const pid = Number(
                  (await target.query("SELECT pg_backend_pid() AS pid")).rows[0]
                    .pid,
                );
                changeLocked(pid);
                await heldChange;
              }
              return result;
            }) as pg.PoolClient["query"];
          },
        });
        return work(guarded);
      }),
  };
  const heldChangeAccounts = emailCredentials(
    heldChangeDb,
    async () => {},
    "https://mydrevo.org",
  );
  const changing = heldChangeAccounts.changePassword(
    account.accountId,
    currentHash,
    "changed strong password one",
    "changed strong password two",
  );
  let changeTimeout: ReturnType<typeof setTimeout> | undefined;
  let changePid: number;
  try {
    changePid = await Promise.race([
      acquiredChangeLock,
      changing.then(() => {
        throw new Error("Password change completed before holding its lock");
      }),
      new Promise<never>((_, reject) => {
        changeTimeout = setTimeout(
          () =>
            reject(
              new Error("Password change did not acquire its credential lock"),
            ),
          10_000,
        );
      }),
    ]);
  } catch (error) {
    releaseChange();
    throw error;
  } finally {
    if (changeTimeout) clearTimeout(changeTimeout);
  }
  const resetting = accounts
    .resetPassword(racingResetToken, "racing reset password")
    .then(
      () => "reset",
      (error: unknown) => error,
    );
  let issuerStarted!: (pid: number) => void;
  const issuerPid = new Promise<number>((resolve) => {
    issuerStarted = resolve;
  });
  const issuing = db.postgresTransaction!(async (transaction) => {
    issuerStarted(
      Number(
        (await transaction.query("SELECT pg_backend_pid() AS pid")).rows[0].pid,
      ),
    );
    return issuePostgresEmailSessionInTransaction(
      transaction,
      racingLogin.accountId,
      racingLogin.passwordHash,
    );
  }).then(
    () => "issued",
    (error: unknown) => error,
  );
  try {
    const waitingPid = await issuerPid;
    let blocked = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const blockers = (
        await client.query<{ pids: number[] }>(
          "SELECT pg_blocking_pids($1) AS pids",
          [waitingPid],
        )
      ).rows[0].pids;
      if (blockers.includes(changePid)) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      blocked,
      true,
      "a checked login must wait on the credential row lock",
    );
  } finally {
    releaseChange();
  }
  assert.equal(await changing, 0);
  assert.ok((await resetting) instanceof InvalidEmailCredential);
  assert.ok((await issuing) instanceof InvalidEmailCredential);
  assert.equal(
    (
      await accounts.login({
        email: "new.person@example.org",
        password: "changed strong password two",
      })
    ).accountId,
    account.accountId,
  );

  const previousEmailFlag = process.env.EMAIL_AUTH_ENABLED;
  process.env.EMAIL_AUTH_ENABLED = "1";
  try {
    const endpoint = emailAuthHttp(
      db,
      {
        accountSession: async (request: IncomingMessage) =>
          request.headers.cookie
            ? { accountId: account.accountId, tokenHash: currentHash }
            : null,
      } as unknown as Parameters<typeof emailAuthHttp>[1],
      "https://mydrevo.org",
      async () => {},
    );
    const call = async (
      currentPassword: string,
      newPassword: string,
      origin = "https://mydrevo.org",
      authenticated = true,
    ) => {
      const body = Buffer.from(
        JSON.stringify({ currentPassword, newPassword }),
      );
      const request = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          cookie: authenticated ? `drevo_session=${currentSession.token}` : "",
        },
        socket: { remoteAddress: "127.0.0.1" },
        async *[Symbol.asyncIterator]() {
          yield body;
        },
      } as unknown as IncomingMessage;
      let status = 0;
      let payload = "";
      const response = {
        writeHead(code: number) {
          status = code;
        },
        end(value: string) {
          payload = value;
        },
      } as unknown as ServerResponse;
      await endpoint.handle(
        request,
        response,
        new URL("https://mydrevo.org/api/auth/email/password/change"),
      );
      return { status, payload };
    };
    assert.equal(
      (
        await call(
          "changed strong password two",
          "changed strong password three",
          "https://evil.example",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "changed strong password two",
          "changed strong password three",
          "https://mydrevo.org",
          false,
        )
      ).status,
      401,
    );
    assert.equal(
      (await call("wrong password", "changed strong password three")).status,
      400,
    );
    const changed = await call(
      "changed strong password two",
      "changed strong password three",
    );
    assert.equal(changed.status, 200);
    assert.deepEqual(JSON.parse(changed.payload), {
      changed: true,
      revokedSessions: 0,
    });
    assert.doesNotMatch(changed.payload, /password|token_hash|scrypt/i);
    assert.equal(
      (
        await client.query(
          "SELECT count(*)::int AS n FROM account_sessions WHERE token_hash=$1",
          [currentHash],
        )
      ).rows[0].n,
      1,
    );
  } finally {
    if (previousEmailFlag === undefined) delete process.env.EMAIL_AUTH_ENABLED;
    else process.env.EMAIL_AUTH_ENABLED = previousEmailFlag;
  }
}
