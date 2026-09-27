import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import { postgresAccessReader } from "../src/server/postgres-access-read.ts";

test("PostgreSQL access reads always scope identity and sessions to membership", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return {
        rows:
          values[0] === "archive-a"
            ? [
                {
                  id: "user-1",
                  name: "Участник",
                  created_at: "2026-01-01T00:00:00Z",
                  last_visit_at: null,
                  role: "reader",
                  approved: false,
                  person_id: "person-1",
                  tree_access: "common_ancestors",
                },
              ]
            : [],
      };
    },
  } as unknown as pg.Client;
  const reader = postgresAccessReader(client, "archive-a");
  assert.deepEqual(await reader.getUser("user-1"), {
    id: "user-1",
    name: "Участник",
    createdAt: "2026-01-01T00:00:00Z",
    role: "reader",
    approved: false,
    personId: "person-1",
    treeAccess: "common_ancestors",
  });
  assert.equal((await reader.getSessionUser("hash", 100))?.approved, false);
  assert.equal(
    await postgresAccessReader(client, "archive-b").getSessionUser("hash", 100),
    null,
  );
  assert.deepEqual(
    calls.map((call) => call.values),
    [
      ["archive-a", "user-1"],
      ["archive-a", "hash", 100],
      ["archive-b", "hash", 100],
    ],
  );
  assert.ok(calls.every((call) => call.sql.includes("m.archive_id=$1")));
  assert.ok(calls[1].sql.includes("s.expires_at>$3"));
});
