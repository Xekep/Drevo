import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { writePortablePostgresBackup } from "../src/server/postgres-portable-backup.ts";
import { backupStore } from "../src/server/backup-store.ts";
import type { StoreDatabase } from "../src/server/store-database.ts";

test("PostgreSQL portable projection reconstructs SQLite usage and copies AI cursors without replaying changes", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "drevo-portable-schema-compatibility-"),
  );
  const original = new DatabaseSync(":memory:");
  initializeArchiveSchema(original);
  original
    .prepare(
      "INSERT INTO users(id,name,role,approved) VALUES('owner','Owner','admin',1)",
    )
    .run();
  original
    .prepare(
      "INSERT INTO ai_chats(id,user_id,access_scope,updated_at,yandex_conversation_id,provider_cleanup_ref) VALUES('chat','owner','scope','saved timestamp','remote-id','cleanup-key')",
    )
    .run();
  original
    .prepare(
      "INSERT INTO ai_chat_messages(id,chat_id,role,content,data) VALUES(7,'chat','assistant','Saved answer','{}')",
    )
    .run();
  original
    .prepare("UPDATE ai_chat_messages SET change_version=40 WHERE id=7")
    .run();
  original
    .prepare(
      "UPDATE ai_chats SET messages_version=41,updated_at='saved timestamp' WHERE id='chat'",
    )
    .run();
  original
    .prepare(
      "INSERT INTO media_originals(url,size_bytes,uploaded_by,created_at) VALUES('/media/original.png',17,'owner','2026-01-01')",
    )
    .run();
  let pending: Array<Record<string, unknown>> = [];
  const declarations: string[] = [];
  const aliases: Record<string, string> = {
    archives: "archive",
    runtime_users: "users",
    account_sessions: "auth_sessions",
    runtime_access_settings: "access_settings",
    runtime_tree_settings: "tree_settings",
    archive_audit_entries: "audit_entries",
    archive_audit_people: "audit_people",
    archive_notification_cursors: "notification_cursors",
    archive_notification_reads: "notification_reads",
  };
  const source = {
    async transaction(work: () => Promise<void>, readOnly: boolean) {
      assert.equal(readOnly, true);
      await work();
    },
    async exec(_sqlite: string, postgres: string) {
      if (!postgres.startsWith("DECLARE ")) return;
      declarations.push(postgres);
      assert.doesNotMatch(
        postgres,
        /FROM "media_storage_usage"/,
        "PostgreSQL has a different counter table",
      );
      if (postgres.includes("count(*) AS files")) {
        pending = original
          .prepare(
            "SELECT 1 AS id,count(*) AS files,coalesce(sum(size_bytes),0) AS bytes FROM media_originals",
          )
          .all();
        return;
      }
      const projection = postgres.slice(postgres.indexOf("FROM (") + 6);
      const table = /\bFROM\s+"?([a-z_]+)"?/.exec(projection)?.[1];
      assert.ok(table, postgres);
      pending = original
        .prepare(`SELECT * FROM "${aliases[table] || table}"`)
        .all()
        .map((row) => ({ ...row }));
      if (table === "ai_chats")
        for (const row of pending) {
          if (projection.includes('NULL AS "yandex_conversation_id"')) row.yandex_conversation_id = null;
          if (projection.includes('NULL AS "provider_cleanup_ref"')) row.provider_cleanup_ref = null;
        }
    },
    prepare(_sqlite: string, postgres: string) {
      assert.equal(postgres, "FETCH FORWARD 500 FROM portable_backup_rows");
      return {
        async all() {
          const rows = pending;
          pending = [];
          return rows;
        },
      };
    },
  } as unknown as StoreDatabase;
  const path = join(directory, "backup.sqlite");
  try {
    await writePortablePostgresBackup(source, path);
    const saved = new DatabaseSync(path);
    try {
      const usage = saved
        .prepare("SELECT files,bytes FROM media_storage_usage WHERE id=1")
        .get()!;
      assert.deepEqual({ ...usage }, { files: 1, bytes: 17 });
      assert.equal(
        saved
          .prepare("SELECT change_version FROM ai_chat_messages WHERE id=7")
          .get()!.change_version,
        40,
      );
      assert.deepEqual(
        {
          ...saved
            .prepare(
              "SELECT messages_version,updated_at,yandex_conversation_id,provider_cleanup_ref FROM ai_chats WHERE id='chat'",
            )
            .get()!,
        },
        {
          messages_version: 41,
          updated_at: "saved timestamp",
          yandex_conversation_id: null,
          provider_cleanup_ref: null,
        },
      );
      saved
        .prepare(
          "INSERT INTO ai_chat_messages(chat_id,role,content,data) VALUES('chat','user','New question','{}')",
        )
        .run();
      assert.equal(
        saved
          .prepare("SELECT messages_version FROM ai_chats WHERE id='chat'")
          .get()!.messages_version,
        42,
        "cursor triggers are restored for subsequent genuine edits",
      );
      assert.equal(
        saved
          .prepare(
            "SELECT change_version FROM ai_chat_messages WHERE content='New question'",
          )
          .get()!.change_version,
        42,
      );
      saved
        .prepare(
          "INSERT INTO media_originals(url,size_bytes,uploaded_by,created_at) VALUES('/media/new.png',3,'owner','2026-01-01')",
        )
        .run();
      assert.deepEqual(
        {
          ...saved
            .prepare("SELECT files,bytes FROM media_storage_usage WHERE id=1")
            .get()!,
        },
        { files: 2, bytes: 20 },
      );
      assert.equal(
        saved.prepare("PRAGMA integrity_check").get()!.integrity_check,
        "ok",
      );
      assert.ok(declarations.some((sql) => sql.includes("count(*) AS files")));
    } finally {
      saved.close();
    }
  } finally {
    original.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("PostgreSQL backup failure schedules the earlier retry with LEAST, not SQLite's scalar min", async () => {
  const database = new DatabaseSync(":memory:");
  initializeArchiveSchema(database);
  const sql: string[] = [];
  const source = {
    kind: "postgres",
    prepare(sqlite: string, postgres: string) {
      sql.push(postgres);
      return database.prepare(sqlite);
    },
  } as unknown as StoreDatabase;
  try {
    const store = await backupStore(source, () => 1000);
    await store.schedule(5000);
    await store.retryBy(2000);
    assert.equal((await store.settings()).next, 2000);
    await store.retryBy(3000);
    assert.equal((await store.settings()).next, 2000);
    assert.ok(
      sql.some((statement) => statement.includes("LEAST(next_run,?::bigint)")),
    );
    assert.ok(!sql.some((statement) => statement.includes("min(next_run")));
  } finally {
    database.close();
  }
});
