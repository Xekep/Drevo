import test from "node:test";
import assert from "node:assert/strict";
import { accountSelfDeletion, AccountDeletionConflict } from "../src/server/account-self-deletion.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";

function fakeDatabase(installed = true) {
  let archiveId = "";
  const writes: Array<{ archiveId: string; sql: string; args: unknown[] }> = [];
  const calls: string[] = [];
  type QueryClient = {
    query(sql: string, args?: unknown[]): Promise<{
      rowCount: number;
      rows: Record<string, unknown>[];
    }>;
  };
  const client: QueryClient = {
    async query(sql: string, args: unknown[] = []) {
      calls.push(sql);
      if (sql.includes("set_config('drevo.archive_id'")) {
        archiveId = String(args[0]);
        return { rowCount: 1, rows: [{}] };
      }
      if (sql.includes("FROM accounts WHERE id=$1 FOR UPDATE"))
        return { rowCount: 1, rows: [{ name: "Имя" }] };
      if (sql.includes("FROM archive_owners"))
        return { rowCount: 0, rows: [] };
      if (sql.includes("FROM platform_admins"))
        return { rowCount: 2, rows: [{ account_id: "other-1" }, { account_id: "other-2" }] };
      if (sql.includes("FROM archive_memberships WHERE user_id=$1"))
        return { rowCount: 1, rows: [{ archive_id: "current-tree" }] };
      if (sql.includes("to_regprocedure"))
        return { rowCount: 1, rows: [{ installed: installed ? "runtime_anonymize_deleted_account_history(text)" : null }] };
      if (sql.includes("SELECT id FROM archives WHERE id=$1 FOR UPDATE"))
        return { rowCount: 1, rows: [{ id: archiveId }] };
      if (/^(UPDATE|DELETE|INSERT|SELECT public\.runtime_anonymize)/.test(sql))
        writes.push({ archiveId, sql, args });
      return { rowCount: 1, rows: [{}] };
    },
  };
  const db = {
    kind: "postgres",
    postgresTransaction: async <T>(work: (connection: QueryClient) => Promise<T>) => work(client),
  } as StoreDatabase;
  return { db, writes, calls };
}

test("account deletion requires consent before changing any rows", async () => {
  const { db, writes } = fakeDatabase();
  await assert.rejects(
    accountSelfDeletion(db, true).remove("account-1", {
      name: "Имя",
      leaveSharedArchives: false,
    }),
    AccountDeletionConflict,
  );
  assert.deepEqual(writes, []);
});

test("account deletion stops before writing if privileged cleanup is not installed", async () => {
  const { db, writes } = fakeDatabase(false);
  await assert.rejects(
    accountSelfDeletion(db, true).remove("account-1", {
      name: "Имя", leaveSharedArchives: true,
    }),
    AccountDeletionConflict,
  );
  assert.deepEqual(writes, []);
});

test("account deletion runs privileged anonymization before removing memberships", async () => {
  const { db, writes, calls } = fakeDatabase();
  const result = await accountSelfDeletion(db, true).remove("account-1", {
    name: "Имя",
    leaveSharedArchives: true,
  });
  assert.deepEqual(result, { deleted: true, sharedArchives: 1 });
  const tombstone = writes.find(({ sql }) => sql.startsWith("INSERT INTO deleted_account_tombstones"));
  assert.ok(tombstone);
  assert.ok(writes.some(({ sql, args }) =>
    sql.startsWith("SELECT public.runtime_anonymize_deleted_account_history") && args[0] === "account-1"));
  assert.ok(calls.findIndex((sql) => sql.startsWith("SELECT public.runtime_anonymize")) <
    calls.findIndex((sql) => sql.startsWith("DELETE FROM archive_memberships")));
  assert.ok(writes.some(({ sql, archiveId }) =>
    archiveId === "current-tree" && sql.startsWith("DELETE FROM archive_memberships")));
  assert.equal(writes.filter(({ sql }) => sql.startsWith("DELETE FROM accounts")).length, 1);
});
