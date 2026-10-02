import assert from "node:assert/strict";
import type { StoreDatabase } from "../../src/server/store-database.ts";
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
}
