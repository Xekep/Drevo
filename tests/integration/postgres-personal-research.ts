import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fixture, family } from "./postgres-fixture.ts";
import { personalResearchStore } from "../../src/server/personal-research.ts";
import {
  postgresBindings,
  type StoreDatabase,
} from "../../src/server/store-database.ts";

test("personal research migration and store isolate archives under ordinary FORCE RLS", async (t) => {
  const cleanup: Array<() => Promise<void>> = [];
  const clients = await fixture({
    after(close: () => Promise<void>) {
      cleanup.push(close);
    },
  } as unknown as Parameters<typeof fixture>[0]);
  const { first } = clients;
  const role = `personal_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  t.after(async () => {
    try {
      await first.query("RESET ROLE");
      if (created) {
        await first.query(`DROP OWNED BY ${role} CASCADE`);
        await first.query(`DROP ROLE ${role}`);
      }
    } finally {
      for (const close of cleanup) await close();
    }
  });
  await first.query(
    readFileSync(
      new URL("../../ops/postgres/107_personal_research.sql", import.meta.url),
      "utf8",
    ),
  );
  const schema = (await first.query("SELECT current_schema() AS name")).rows[0]
    .name;
  await first.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  created = true;
  await first.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  await first.query(
    `GRANT SELECT,INSERT,UPDATE,DELETE ON personal_bookmarks,personal_people_filters,audit_reverts TO ${role}`,
  );
  await first.query(`SET ROLE ${role}`);
  const store = personalResearchStore({
    kind: "postgres",
    archiveId: "tree-a",
    prepare(sqlite: string, postgres = sqlite) {
      const sql = postgresBindings(postgres);
      return {
        async get(...values: unknown[]) {
          return (await first.query(sql, values)).rows[0];
        },
        async all(...values: unknown[]) {
          return (await first.query(sql, values)).rows;
        },
        async run(...values: unknown[]) {
          const result = await first.query(sql, values);
          return { changes: result.rowCount || 0, lastInsertRowid: 0 };
        },
      };
    },
  } as unknown as StoreDatabase);
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await first.query("SELECT set_config('drevo.account_id','relative',false)");
  await store.bookmark("relative", { kind: "person", id: "child" }, false);
  await store.saveFilter(
    "relative",
    "Дети",
    { allOf: [{ birthYearFrom: 1970 }] },
    family,
  );
  assert.equal((await store.bookmarks("relative")).length, 1);
  assert.equal((await store.bookmarks("reader")).length, 0);
  assert.equal((await store.filters("relative")).length, 1);
  await first.query("SELECT set_config('drevo.account_id','reader',false)");
  assert.equal(
    (await first.query("SELECT count(*)::int AS n FROM personal_bookmarks"))
      .rows[0].n,
    0,
    "RLS also isolates users without a WHERE clause",
  );
  assert.equal(
    (
      await first.query(
        "SELECT count(*)::int AS n FROM personal_people_filters",
      )
    ).rows[0].n,
    0,
  );
  await first.query("SELECT set_config('drevo.account_id','relative',false)");
  await first.query(
    "INSERT INTO audit_reverts(revision,reverted_revision) VALUES(1,3)",
  );
  await first.query("SELECT set_config('drevo.archive_id','tree-b',false)");
  assert.equal((await store.bookmarks("relative")).length, 0);
  assert.equal((await store.filters("relative")).length, 0);
  assert.equal(
    (await first.query("SELECT count(*)::int AS n FROM audit_reverts")).rows[0]
      .n,
    0,
  );
  await store.bookmark("relative", { kind: "person", id: "child" }, false);
  await first.query(
    "INSERT INTO audit_reverts(revision,reverted_revision) VALUES(1,4)",
  );
  await assert.rejects(
    first.query(
      "INSERT INTO personal_bookmarks(archive_id,user_id,kind,entity_id,created_ms) VALUES('tree-a','relative','person','father',0)",
    ),
    /row-level security/,
  );
  await first.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  await store.bookmark("relative", { kind: "person", id: "child" }, true);
  assert.equal((await store.bookmarks("relative")).length, 0);
  await first.query("SELECT set_config('drevo.archive_id','tree-b',false)");
  assert.equal((await store.bookmarks("relative")).length, 1);
});
