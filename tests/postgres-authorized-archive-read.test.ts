import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { readPostgresArchiveForSession } from "../src/server/postgres-authorized-archive-read.ts";
import { sessionTokenHash } from "../src/server/session-token.ts";

const token = "a".repeat(64);
const archiveId = "tree-a";

function mockClient(approved = true) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes("FROM account_sessions s"))
        return {
          rows: [
            {
              archive_id: archiveId,
              title: "Семейное древо",
              owned: false,
              id: "user-a",
              name: "Участник",
              created_at: "2026-01-01T00:00:00Z",
              last_visit_at: null,
              role: "reader",
              approved,
              person_id: "person-a",
              tree_access: "common_ancestors",
            },
          ],
        };
      if (sql.startsWith("SELECT title,description"))
        return {
          rows: [
            {
              title: "Семейное древо",
              description: "",
              demo: false,
              revision: 7,
            },
          ],
        };
      if (sql.startsWith("SELECT data FROM people"))
        return {
          rows: [
            { data: { id: "person-a", name: "Видимый" } },
            { data: { id: "person-b", name: "Закрытый" } },
          ],
        };
      return { rows: [] };
    },
  } as unknown as pg.Client;
  return { client, calls };
}

test("archive read requires an active membership in the requested archive", async () => {
  const { client, calls } = mockClient();
  assert.equal(
    await readPostgresArchiveForSession(client, token, "tree-b", 100),
    null,
  );
  assert.equal(
    calls.some(({ sql }) => sql.startsWith("SELECT title,description")),
    false,
  );
  assert.equal(calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(calls.at(-1)?.sql, "COMMIT");
  const membershipQuery = calls.find(({ sql }) =>
    sql.includes("FROM account_sessions s"),
  );
  assert.deepEqual(membershipQuery?.values, [sessionTokenHash(token), 100]);
  assert.equal(membershipQuery?.sql.includes("m.user_id=a.id"), true);
});

test("unapproved membership and malformed tokens never read archive data", async () => {
  const { client, calls } = mockClient(false);
  assert.equal(
    await readPostgresArchiveForSession(client, token, archiveId, 100),
    null,
  );
  assert.equal(
    calls.some(({ sql }) => sql.startsWith("SELECT title,description")),
    false,
  );
  calls.length = 0;
  assert.equal(
    await readPostgresArchiveForSession(client, "invalid", archiveId, 100),
    null,
  );
  assert.deepEqual(calls, []);
});

test("scoped membership only receives its visible family projection", async () => {
  const { client, calls } = mockClient();
  const result = await readPostgresArchiveForSession(
    client,
    token,
    archiveId,
    100,
  );
  assert.equal(result?.archiveId, archiveId);
  assert.equal(result?.revision, 7);
  assert.deepEqual(
    result?.family.people.map(({ id }) => id),
    ["person-a"],
  );
  assert.equal(result?.user.treeAccess, "common_ancestors");
  assert.equal(calls.at(-1)?.sql, "COMMIT");
  assert.ok(
    calls
      .filter(
        ({ sql }) =>
          sql.includes("FROM people") || sql.includes("FROM archives"),
      )
      .every(({ values }) => values?.[0] === archiveId),
  );
});

test("a database failure rolls back the session-bound read", async () => {
  const { client, calls } = mockClient();
  const originalQuery = client.query.bind(client);
  client.query = (async (sql: string, values?: unknown[]) => {
    if (sql.startsWith("SELECT data FROM people"))
      throw new Error("read failed");
    return originalQuery(sql, values);
  }) as pg.Client["query"];
  await assert.rejects(
    readPostgresArchiveForSession(client, token, archiveId, 100),
    /read failed/,
  );
  assert.equal(calls.at(-1)?.sql, "ROLLBACK");
});
