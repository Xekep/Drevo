import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { createAuth } from "../../src/server/auth.ts";
import { userStore } from "../../src/server/users.ts";
import {
  newSessionToken,
  sessionTokenHash,
} from "../../src/server/session-token.ts";

type SessionItem = {
  id: string;
  isCurrent: boolean;
  createdAt: string | null;
  expiresAt: string;
};

export async function verifyAccountSessionManagement(
  db: StoreDatabase,
  base: string,
  ownerHeaders: Record<string, string>,
  readerHeaders: Record<string, string>,
) {
  const otherToken = newSessionToken();
  const otherHash = sessionTokenHash(otherToken);
  await db
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)",
    )
    .run(otherHash, Date.now() + 60_000);
  const other = await db
    .prepare(
      "",
      "SELECT public_id::text AS id,created_at FROM account_sessions WHERE token_hash=?",
    )
    .get(otherHash);
  const otherId = String(other?.id);
  assert.match(otherId, /^[0-9a-f-]{36}$/);
  assert.notEqual(otherId, otherHash, "the public ID is never the token hash");
  assert.ok(other?.created_at, "new sessions record a login time");

  const ownerResponse = await fetch(base + "/api/account/sessions", {
    headers: ownerHeaders,
  });
  assert.equal(ownerResponse.status, 200);
  const ownerSummary = (await ownerResponse.json()) as {
    otherCount: number;
    items: SessionItem[];
  };
  assert.equal(ownerSummary.items[0].isCurrent, true);
  assert.ok(
    ownerSummary.items.some(
      (item) => item.id === otherId && item.isCurrent === false,
    ),
  );
  assert.ok(Date.parse(ownerSummary.items[0].expiresAt) > Date.now());
  assert.ok(ownerSummary.items.find((item) => item.id === otherId)?.createdAt);
  assert.ok(!JSON.stringify(ownerSummary).includes(otherHash));
  assert.ok(!JSON.stringify(ownerSummary).includes(otherToken));
  const currentId = ownerSummary.items[0].id;

  const revokeUrl = (id: string) => `${base}/api/account/sessions/${id}/revoke`;
  assert.equal(
    (
      await fetch(revokeUrl(otherId), {
        method: "POST",
        headers: { ...ownerHeaders, Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const readerSummary = (await fetch(base + "/api/account/sessions", {
    headers: readerHeaders,
  }).then((response) => response.json())) as { items: SessionItem[] };
  assert.ok(!readerSummary.items.some((item) => item.id === otherId));
  assert.deepEqual(
    await fetch(revokeUrl(otherId), {
      method: "POST",
      headers: readerHeaders,
    }).then((response) => response.json()),
    { revoked: false },
  );
  assert.equal(
    (
      await fetch(revokeUrl(currentId), {
        method: "POST",
        headers: ownerHeaders,
      })
    ).status,
    409,
    "current session uses explicit logout",
  );
  assert.deepEqual(
    await fetch(revokeUrl(otherId), {
      method: "POST",
      headers: ownerHeaders,
    }).then((response) => response.json()),
    { revoked: true },
  );
  assert.deepEqual(
    await fetch(revokeUrl(otherId), {
      method: "POST",
      headers: ownerHeaders,
    }).then((response) => response.json()),
    { revoked: false },
  );
  assert.equal(
    (
      await fetch(base + "/api/account/sessions", {
        headers: { Cookie: `drevo_session=${otherToken}` },
      })
    ).status,
    401,
  );
  assert.equal(
    (await fetch(base + "/api/account/sessions", { headers: ownerHeaders }))
      .status,
    200,
  );

  const racingToken = newSessionToken();
  const racingHash = sessionTokenHash(racingToken);
  await db
    .prepare(
      "",
      "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)",
    )
    .run(racingHash, Date.now() + 60_000);
  const racingId = String(
    (
      await db
        .prepare(
          "",
          "SELECT public_id::text AS id FROM account_sessions WHERE token_hash=?",
        )
        .get(racingHash)
    )?.id,
  );
  const results = await Promise.all([
    fetch(revokeUrl(racingId), { method: "POST", headers: ownerHeaders }).then(
      (response) => response.json(),
    ),
    fetch(revokeUrl(racingId), { method: "POST", headers: ownerHeaders }).then(
      (response) => response.json(),
    ),
  ]);
  assert.deepEqual(
    results.map((result) => result.revoked).sort(),
    [false, true],
    "concurrent revocations delete one session only once",
  );

  const delayedToken = newSessionToken();
  const delayedHash = sessionTokenHash(delayedToken);
  const survivingToken = newSessionToken();
  const survivingHash = sessionTokenHash(survivingToken);
  for (const tokenHash of [delayedHash, survivingHash])
    await db
      .prepare(
        "",
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'owner',?)",
      )
      .run(tokenHash, Date.now() + 60_000);
  let releaseBulk!: () => void;
  let bulkReached!: () => void;
  const heldBulk = new Promise<void>((resolve) => {
    releaseBulk = resolve;
  });
  const reachedBulk = new Promise<void>((resolve) => {
    bulkReached = resolve;
  });
  const delayedDb: StoreDatabase = {
    ...db,
    prepare(sqlite, postgres) {
      const statement = db.prepare(sqlite, postgres);
      if (!postgres?.includes("WITH current_session AS MATERIALIZED"))
        return statement;
      return {
        ...statement,
        get: async (...values) => {
          bulkReached();
          await heldBulk;
          return statement.get(...values);
        },
      };
    },
  };
  const delayedAuth = await createAuth(
    await userStore(db),
    delayedDb,
    "https://mydrevo.org",
  );
  const delayedRequest = {
    headers: { cookie: `drevo_session=${delayedToken}` },
  } as IncomingMessage;
  const lateBulk = delayedAuth.revokeOtherSessions(delayedRequest);
  let bulkTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      reachedBulk,
      new Promise<never>((_, reject) => {
        bulkTimeout = setTimeout(
          () =>
            reject(new Error("Bulk revoke did not reach its SQL statement")),
          10_000,
        );
      }),
    ]);
    await db
      .prepare("", "DELETE FROM account_sessions WHERE token_hash=?")
      .run(delayedHash);
  } finally {
    if (bulkTimeout) clearTimeout(bulkTimeout);
    releaseBulk();
  }
  assert.equal(
    await lateBulk,
    null,
    "a session revoked after initial lookup cannot bulk-revoke the account",
  );
  assert.equal(
    Number(
      (
        await db
          .prepare(
            "",
            "SELECT count(*) AS count FROM account_sessions WHERE token_hash=?",
          )
          .get(survivingHash)
      )?.count,
    ),
    1,
  );
  await db
    .prepare("", "DELETE FROM account_sessions WHERE token_hash=?")
    .run(survivingHash);

  await db
    .prepare(
      "",
      "INSERT INTO accounts(id,name,created_at) VALUES('bulk-revoke-case','Bulk revoke test',?)",
    )
    .run(new Date().toISOString());
  const validToken = newSessionToken();
  const extraToken = newSessionToken();
  const validHash = sessionTokenHash(validToken);
  const extraHash = sessionTokenHash(extraToken);
  for (const tokenHash of [validHash, extraHash])
    await db
      .prepare(
        "",
        "INSERT INTO account_sessions(token_hash,user_id,expires_at) VALUES(?,'bulk-revoke-case',?)",
      )
      .run(tokenHash, Date.now() + 60_000);
  try {
    const normalAuth = await createAuth(
      await userStore(db),
      db,
      "https://mydrevo.org",
    );
    assert.equal(
      await normalAuth.revokeOtherSessions({
        headers: { cookie: `drevo_session=${validToken}` },
      } as IncomingMessage),
      1,
    );
    const sessions = await db
      .prepare(
        "",
        "SELECT token_hash FROM account_sessions WHERE user_id='bulk-revoke-case'",
      )
      .all();
    assert.deepEqual(
      sessions.map((row) => row.token_hash),
      [validHash],
    );
    assert.equal(
      await normalAuth.revokeOtherSessions({
        headers: { cookie: `drevo_session=${validToken}` },
      } as IncomingMessage),
      0,
      "zero other sessions differs from a revoked caller",
    );
  } finally {
    await db
      .prepare("", "DELETE FROM accounts WHERE id='bulk-revoke-case'")
      .run();
  }
}
