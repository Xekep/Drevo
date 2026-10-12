import test from "node:test";
import assert from "node:assert/strict";
import type pg from "pg";
import {
  initializePostgresRuntimeSchema,
  runtimeSchemaCoordinator,
} from "../src/server/postgres-runtime-schema.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";

test("one pool checks global schema once while every archive retains its scoped backfills", async () => {
  const coordinator = runtimeSchemaCoordinator();
  const queries: Array<{ archive: string; query: string }> = [];
  const db = (archive: string): StoreDatabase => ({
    kind: "postgres",
    file: archive,
    archiveId: archive,
    inTransaction: () => false,
    canReuseGraphCache: () => true,
    prepare(_sqlite, query = "") {
      return {
        get: async () => {
          queries.push({ archive, query });
          return { present: 1 };
        },
        all: async () => [],
        run: async () => {
          queries.push({ archive, query });
          return { changes: 1, lastInsertRowid: 0 };
        },
      };
    },
    exec: async (_sqlite, query = "") => {
      queries.push({ archive, query });
    },
    transaction: async (work) => work(),
    close: async () => {},
  });
  await Promise.all([
    initializePostgresRuntimeSchema(db("first"), coordinator),
    initializePostgresRuntimeSchema(db("second"), coordinator),
  ]);
  const global = queries.filter(({ query }) =>
    query.includes("column_name='animate_on_load'"),
  );
  assert.equal(global.length, 1);
  const originalProbe = queries.findIndex(({ query }) =>
    query.includes("to_regclass('media_originals') AS present"),
  );
  const counterProbe = queries.findIndex(({ query }) =>
    query.includes("to_regclass('archive_media_storage_usage') AS present"),
  );
  const cursorProbe = queries.findIndex(({ query }) =>
    query.includes("column_name='messages_version'"),
  );
  assert.ok(originalProbe >= 0 && counterProbe > originalProbe);
  assert.ok(cursorProbe > counterProbe);
  for (const archive of ["first", "second"])
    assert.ok(
      queries.some(
        (entry) =>
          entry.archive === archive &&
          entry.query.includes("UPDATE ai_chat_messages SET change_version=id"),
      ),
    );

  for (const archive of ["first", "second"])
    assert.ok(
      queries.some(
        (entry) =>
          entry.archive === archive &&
          entry.query.includes(
            "UPDATE archive_memberships SET role='relative'",
          ),
      ),
    );
});

test("a partial runtime installs original-file storage before its dependent usage triggers", async () => {
  let originals = false;
  let counter = false;
  const installed: string[] = [];
  const present = (query: string) => {
    if (query.includes("to_regclass('media_originals') AS present"))
      return originals;
    if (query.includes("to_regclass('archive_media_storage_usage') AS present"))
      return counter;
    return true;
  };
  const db: StoreDatabase = {
    kind: "postgres",
    file: "partial-runtime",
    archiveId: "partial-runtime",
    inTransaction: () => false,
    canReuseGraphCache: () => true,
    prepare(_sqlite, query = "") {
      return {
        get: async () => ({ present: present(query) ? 1 : null }),
        all: async () => [],
        run: async () => ({ changes: 0, lastInsertRowid: 0 }),
      };
    },
    exec: async (_sqlite, query = "") => {
      if (query.includes("CREATE TABLE IF NOT EXISTS media_originals")) {
        originals = true;
        installed.push("015");
      }
    },
    transaction: async (work) => work(),
    postgresTransaction: async (work) =>
      work({
        async query(query: string) {
          if (
            query.includes(
              "CREATE TABLE IF NOT EXISTS archive_media_storage_usage",
            )
          ) {
            assert.equal(
              originals,
              true,
              "102 requires the real 015 table before trigger DDL",
            );
            counter = true;
            installed.push("102");
          }
          return { rows: [{ present: present(query) ? 1 : null }] };
        },
      } as unknown as pg.PoolClient),
    close: async () => {},
  };
  await initializePostgresRuntimeSchema(db);
  assert.deepEqual(installed, ["015", "102"]);
});

test("a failed schema initialization remains retryable, concurrent callers share its result", async () => {
  const coordinator = runtimeSchemaCoordinator();
  let attempts = 0;
  const failure = () => {
    attempts++;
    return Promise.reject(new Error("isolated schema failure"));
  };
  const failed = await Promise.allSettled([
    coordinator.ensure(failure),
    coordinator.ensure(failure),
  ]);
  assert.ok(failed.every((value) => value.status === "rejected"));
  assert.equal(attempts, 1);
  await coordinator.ensure(async () => {
    attempts++;
  });
  await coordinator.ensure(async () => {
    attempts++;
  });
  assert.equal(attempts, 2);
});
