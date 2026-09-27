import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import {
  issuePostgresSessionInTransaction,
  recordPostgresVisit,
  renewPostgresSession,
  revokePostgresSession,
} from "../src/server/postgres-sessions.ts";
import {
  sessionTokenHash,
  validSessionToken,
  SESSION_MAX_AGE,
} from "../src/server/session-token.ts";

test("PostgreSQL stores only token hashes and rotates the previous session", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return { rowCount: 1 };
    },
  } as unknown as pg.Client;
  const previous = "a".repeat(64);
  const issued = await issuePostgresSessionInTransaction(
    client,
    "account-1",
    previous,
    1_000,
  );
  assert.equal(validSessionToken(issued.token), true);
  assert.notEqual(issued.token, previous);
  assert.equal(issued.expiresAt, 1_000 + SESSION_MAX_AGE * 1_000);
  assert.deepEqual(calls[0].values, [sessionTokenHash(previous)]);
  const insert = calls.find(({ sql }) =>
    sql.includes("INSERT INTO account_sessions"),
  );
  assert.deepEqual(insert?.values, [
    sessionTokenHash(issued.token),
    "account-1",
    issued.expiresAt,
  ]);
  assert.ok(calls.every(({ values }) => !values.includes(issued.token)));
  assert.equal(await revokePostgresSession(client, issued.token), true);
  assert.deepEqual(calls.at(-1)?.values, [sessionTokenHash(issued.token)]);
});

test("invalid tokens never reach session renewal, visit or revocation SQL", async () => {
  let queries = 0;
  const client = {
    async query() {
      queries++;
      return { rowCount: 1 };
    },
  } as unknown as pg.Client;
  assert.equal(await renewPostgresSession(client, "invalid", 1_000), false);
  assert.equal(await recordPostgresVisit(client, "invalid", 1_000), false);
  assert.equal(await revokePostgresSession(client, "invalid"), false);
  assert.equal(queries, 0);
});
