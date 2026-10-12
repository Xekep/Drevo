import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type pg from "pg";
import { fixture, waitForLock } from "./postgres-fixture.ts";
import { aiChatStore } from "../../src/server/ai-chats.ts";
import { postgresBindings, type StoreDatabase } from "../../src/server/store-database.ts";

const migration = (file: string) => readFileSync(new URL(`../../ops/postgres/${file}`, import.meta.url), "utf8");

async function cursorFixture(t: Parameters<typeof fixture>[0]) {
  const cleanup: Array<() => Promise<void>> = [];
  const resources: { clients?: Awaited<ReturnType<typeof fixture>> } = {};
  const role = `ai_cursor_${randomUUID().replaceAll("-", "")}`;
  let created = false;
  t.after(async () => {
    try {
      const clients = resources.clients;
      if (clients) {
        for (const client of Object.values(clients)) {
          await client.query("ROLLBACK");
          await client.query("RESET ROLE");
        }
        if (created) {
          await clients.first.query(`DROP OWNED BY ${role} CASCADE`);
          await clients.first.query(`DROP ROLE ${role}`);
        }
      }
    } finally { for (const close of cleanup) await close(); }
  });
  const clients = await fixture({ after(close: () => Promise<void>) { cleanup.push(close); } } as unknown as Parameters<typeof fixture>[0]);
  resources.clients = clients;
  const schema = String((await clients.first.query("SELECT current_schema() AS schema")).rows[0].schema);
  const runtime = migration("010_runtime_services.sql");
  // Install actual production DDL for this focused service; the fixture already
  // owns core tables and audit redaction, but intentionally omits research/AI.
  for (const table of ["research_suggestions", "ai_chats", "ai_chat_messages"]) {
    const definition = runtime.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\);`));
    const policy = runtime.match(new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;[\\s\\S]*?CREATE POLICY archive_scope ON ${table}[\\s\\S]*?;`));
    assert.ok(definition && policy);
    await clients.first.query(definition[0]);
    await clients.first.query(policy[0]);
  }
  await clients.first.query(migration("079_ai_chat_stop.sql"));
  const cleanupColumn = migration("082_ai_provider_cleanup.sql").match(/ALTER TABLE ai_chats ADD COLUMN IF NOT EXISTS provider_cleanup_ref uuid;/);
  assert.ok(cleanupColumn);
  await clients.first.query(cleanupColumn[0]);
  const historyView = migration("041_deleted_account_history.sql").split("CREATE OR REPLACE VIEW runtime_visible_research_suggestions")[1];
  assert.ok(historyView);
  await clients.first.query("CREATE OR REPLACE VIEW runtime_visible_research_suggestions" + historyView);
  const cursorSource = migration("103_ai_chat_message_cursors.sql");
  // Identical service IDs in two archives expose missing archive predicates in
  // cursor allocation, proposal propagation, and public message projections.
  for (const archive of ["tree-a", "tree-b"]) {
    await clients.first.query("SELECT set_config('drevo.archive_id',$1,false)", [archive]);
    await clients.first.query("INSERT INTO ai_chats(id,user_id,access_scope) VALUES('cursor-chat','admin','all')");
    await clients.first.query(`INSERT INTO research_suggestions(id,kind,status,person_id,payload,reason,evidence,base_revision,created_at,created_by)
      VALUES('shared-proposal','person_update','pending','father','{}','','[]',0,'2026-10-12','admin')`);
    await clients.first.query(`INSERT INTO ai_chat_messages(chat_id,role,content,data)
      SELECT 'cursor-chat','assistant',$1||n::text,CASE WHEN n=105 THEN '{"suggestionIds":["shared-proposal"]}'::jsonb ELSE '{}'::jsonb END FROM generate_series(1,105) n`, [`${archive}:`]);
  }
  await clients.first.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  created = true;
  await clients.first.query(`GRANT USAGE,CREATE ON SCHEMA ${schema} TO ${role}`);
  await clients.first.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${role}`);
  await clients.first.query(`GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`);
  // The application migration role is ordinary and owns the service tables.
  // FORCE RLS applies to their owner; superuser execution would hide mistakes.
  for (const table of ["research_suggestions", "ai_chats", "ai_chat_messages"])
    await clients.first.query(`ALTER TABLE ${table} OWNER TO ${role}`);
  for (const client of Object.values(clients)) await client.query(`SET ROLE ${role}`);
  const capabilities = (await clients.first.query("SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows[0];
  assert.deepEqual(capabilities, { rolsuper: false, rolbypassrls: false });
  for (const archive of ["tree-a", "tree-b"]) {
    await clients.first.query("SELECT set_config('drevo.archive_id',$1,false)", [archive]);
    await clients.first.query(cursorSource);
  }
  for (const client of Object.values(clients)) await client.query("SELECT set_config('drevo.archive_id','tree-a',false)");
  return clients;
}

function store(client: pg.Client, archiveId = "tree-a") {
  const normalize = (row: Record<string, unknown> | undefined) => row && Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value !== null && typeof value === "object" ? JSON.stringify(value) : value]));
  return aiChatStore({ kind: "postgres", archiveId, prepare(_sqlite: string, postgres: string) {
    const sql = postgresBindings(postgres);
    return {
      async get(...values: unknown[]) { return normalize((await client.query(sql, values)).rows[0]); },
      async all(...values: unknown[]) { return (await client.query(sql, values)).rows.map(normalize); },
      async run(...values: unknown[]) { const result = await client.query(sql, values); return { changes: result.rowCount ?? 0, lastInsertRowid: Number(result.rows[0]?.id ?? 0) }; },
    };
  } } as unknown as StoreDatabase);
}

test("native103 ordinary RLS backfill/pages isolate identical chat/proposal IDs across archives", async t => {
  const { first, second } = await cursorFixture(t);
  const chats = store(first);
  const page = (await chats.historyPage("cursor-chat", "admin"))!;
  assert.equal(page.messages.length, 100);
  assert.equal(page.messages[0].content, "tree-a:6");
  assert.equal(page.messages.at(-1)!.content, "tree-a:105");
  const older = (await chats.historyPage("cursor-chat", "admin", page.nextBefore!))!;
  assert.equal(older.messages.length, 5);
  assert.equal(older.nextBefore, null);
  assert.equal(await chats.historyPage("cursor-chat", "outsider"), null);
  const before = (await chats.head("cursor-chat", "admin"))!;
  await first.query("UPDATE research_suggestions SET status='accepted' WHERE id='shared-proposal'");
  const delta = (await chats.changesAfter("cursor-chat", "admin", before.version))!;
  assert.equal(delta.messages.length, 1);
  assert.equal(delta.messages[0].suggestionStatuses?.["shared-proposal"], "accepted");
  assert.ok(delta.lastVersion > before.version);
  assert.equal((await first.query("SELECT * FROM ai_chats WHERE archive_id='tree-b'")).rowCount, 0);
  await second.query("SELECT set_config('drevo.archive_id','tree-b',false)");
  const other = (await store(second, "tree-b").historyPage("cursor-chat", "admin"))!;
  assert.equal(other.messages.at(-1)!.content, "tree-b:105");
  assert.equal(other.messages.at(-1)!.suggestionStatuses?.["shared-proposal"], "pending");
});

test("native103 proposal rollback cannot advance a cursor, and concurrent appends serialize committed versions", async t => {
  const { first, second, third } = await cursorFixture(t);
  const chats = store(third);
  const before = (await chats.head("cursor-chat", "admin"))!;
  await first.query("BEGIN");
  await first.query("UPDATE research_suggestions SET status='accepted' WHERE id='shared-proposal'");
  await second.query("BEGIN");
  const pendingInsert = second.query("INSERT INTO ai_chat_messages(chat_id,role,content) VALUES('cursor-chat','user','Parallel append') RETURNING change_version");
  await waitForLock(third, second);
  assert.deepEqual((await chats.changesAfter("cursor-chat", "admin", before.version))!.messages, [], "uncommitted review is invisible to another tab");
  await first.query("ROLLBACK");
  const inserted = await pendingInsert;
  await second.query("COMMIT");
  assert.equal(Number(inserted.rows[0].change_version), before.version + 1);
  const afterAppend = (await chats.changesAfter("cursor-chat", "admin", before.version))!;
  assert.equal(afterAppend.messages.length, 1);
  assert.equal(afterAppend.messages[0].content, "Parallel append");
  await first.query("UPDATE research_suggestions SET status='rejected' WHERE id='shared-proposal'");
  const reviewed = (await chats.changesAfter("cursor-chat", "admin", afterAppend.lastVersion))!;
  assert.equal(reviewed.messages.length, 1);
  assert.equal(reviewed.messages[0].suggestionStatuses?.["shared-proposal"], "rejected");
  assert.equal(reviewed.lastVersion, afterAppend.lastVersion + 1);
});
