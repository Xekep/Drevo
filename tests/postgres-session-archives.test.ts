import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import {
  postgresSessionArchives,
  selectPostgresSessionArchive,
} from "../src/server/postgres-session-archives.ts";

test("a global session keeps separate rights for each archive and rejects an invalid selection", async () => {
  const calls: { sql: string; values: unknown[] }[] = [];
  const client = {
    async query(sql: string, values: unknown[]) {
      calls.push({ sql, values });
      return {
        rows: [
          {
            archive_id: "own-tree",
            title: "Моё дерево",
            owned: true,
            id: "account-1",
            name: "Участник",
            created_at: "2026-01-01T00:00:00Z",
            last_visit_at: null,
            role: "admin",
            approved: true,
            person_id: null,
            tree_access: "all",
          },
          {
            archive_id: "invited-tree",
            title: "Чужое дерево",
            owned: false,
            id: "account-1",
            name: "Участник",
            created_at: "2026-01-01T00:00:00Z",
            last_visit_at: null,
            role: "reader",
            approved: false,
            person_id: "person-2",
            tree_access: "common_ancestors",
          },
        ],
      };
    },
  } as unknown as pg.Client;

  const archives = await postgresSessionArchives(client, "session-hash", 100);
  assert.deepEqual(
    archives.map(({ archiveId, owned, user }) => ({
      archiveId,
      owned,
      role: user.role,
      approved: user.approved,
      personId: user.personId,
    })),
    [
      {
        archiveId: "own-tree",
        owned: true,
        role: "admin",
        approved: true,
        personId: undefined,
      },
      {
        archiveId: "invited-tree",
        owned: false,
        role: "reader",
        approved: false,
        personId: "person-2",
      },
    ],
  );
  assert.equal(
    (await selectPostgresSessionArchive(client, "session-hash", undefined, 100))
      ?.archiveId,
    "own-tree",
  );
  assert.equal(
    await selectPostgresSessionArchive(
      client,
      "session-hash",
      "invited-tree",
      100,
    ),
    null,
  );
  assert.equal(
    await selectPostgresSessionArchive(
      client,
      "session-hash",
      "other-tree",
      100,
    ),
    null,
  );
  assert.ok(
    calls.every(({ sql }) =>
      sql.includes("s.token_hash=$1 AND s.expires_at>$2"),
    ),
  );
  assert.ok(
    calls.every(
      ({ values }) => values[0] === "session-hash" && values[1] === 100,
    ),
  );
});
