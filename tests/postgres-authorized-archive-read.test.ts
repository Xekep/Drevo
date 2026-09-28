import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import {
  readPostgresArchiveForSession,
  readPostgresAuditForSession,
  readPostgresSettingsForSession,
  readPostgresUsersForSession,
} from "../src/server/postgres-authorized-archive-read.ts";
import { sessionTokenHash } from "../src/server/session-token.ts";

const token = "a".repeat(64);
const archiveId = "tree-a";

function mockClient(
  approved = true,
  role: "admin" | "reader" = "reader",
  owned = false,
) {
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
              owned,
              id: "user-a",
              name: "Участник",
              created_at: "2026-01-01T00:00:00Z",
              last_visit_at: null,
              role,
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
      if (sql.includes("FROM archive_audit_entries a"))
        return {
          rows: [
            {
              id: "9",
              at: "2026-01-01T00:00:00Z",
              actor_id: "user-a",
              actor_name: "Участник",
              action: "Изменение",
              entity: "person",
              entity_id: "person-a",
              label: "Видимый",
              revision: "7",
              details: [],
            },
          ],
        };
      if (sql.includes("FROM archive_memberships m"))
        return {
          rows: [
            {
              id: "user-a",
              name: "Участник",
              created_at: "2026-01-01T00:00:00Z",
              last_visit_at: null,
              role,
              approved: true,
              person_id: "person-a",
              tree_access: "all",
            },
          ],
        };
      if (sql.includes("FROM archive_access_settings s"))
        return {
          rows: [
            {
              public_tree: false,
              public_albums: false,
              reverse_timeline: true,
            },
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

test("audit requires archive admin rights and remains archive-scoped", async () => {
  const reader = mockClient();
  assert.equal(
    await readPostgresAuditForSession(reader.client, token, archiveId, {}, 100),
    null,
  );
  assert.equal(
    reader.calls.some(({ sql }) =>
      sql.includes("FROM archive_audit_entries a"),
    ),
    false,
  );

  const admin = mockClient(true, "admin");
  assert.equal(
    await readPostgresAuditForSession(admin.client, token, "tree-b", {}, 100),
    null,
  );
  const result = await readPostgresAuditForSession(
    admin.client,
    token,
    archiveId,
    { personId: "person-a", before: 10 },
    100,
  );
  assert.equal(result?.items[0].id, 9);
  const auditQuery = admin.calls.find(({ sql }) =>
    sql.includes("FROM archive_audit_entries a"),
  );
  assert.deepEqual(auditQuery?.values, [archiveId, 10, "", "person-a"]);
  assert.match(auditQuery?.sql || "", /a\.archive_id=\$1/);
});

test("membership list and settings require admin rights in the selected archive", async () => {
  const reader = mockClient();
  assert.equal(
    await readPostgresUsersForSession(reader.client, token, archiveId, 100),
    null,
  );
  assert.equal(
    await readPostgresSettingsForSession(reader.client, token, archiveId, 100),
    null,
  );
  assert.equal(
    reader.calls.some(({ sql }) => sql.includes("FROM archive_memberships m")),
    false,
  );
  assert.equal(
    reader.calls.some(({ sql }) =>
      sql.includes("FROM archive_access_settings s"),
    ),
    false,
  );

  const admin = mockClient(true, "admin");
  assert.equal(
    await readPostgresUsersForSession(admin.client, token, "tree-b", 100),
    null,
  );
  const users = await readPostgresUsersForSession(
    admin.client,
    token,
    archiveId,
    100,
  );
  const settings = await readPostgresSettingsForSession(
    admin.client,
    token,
    archiveId,
    100,
  );
  assert.deepEqual(
    users?.map(({ id }) => id),
    ["user-a"],
  );
  assert.deepEqual(settings, {
    publicTree: false,
    publicAlbums: false,
    reverseTimeline: true,
  });
  assert.ok(
    admin.calls
      .filter(
        ({ sql }) =>
          sql.includes("FROM archive_memberships m") ||
          sql.includes("FROM archive_access_settings s"),
      )
      .every(({ values }) => values?.[0] === archiveId),
  );
});

test("archive ownership grants local management even without the admin role", async () => {
  const owner = mockClient(true, "reader", true);
  const users = await readPostgresUsersForSession(
    owner.client,
    token,
    archiveId,
    100,
  );
  const audit = await readPostgresAuditForSession(
    owner.client,
    token,
    archiveId,
    {},
    100,
  );
  assert.deepEqual(
    users?.map(({ id }) => id),
    ["user-a"],
  );
  assert.equal(audit?.items[0].id, 9);
});
