import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectSqliteSnapshot } from "../ops/postgres/import-sqlite.ts";
import { planArchiveAccess } from "../ops/postgres/backfill-archive-access.ts";
import { initializeArchiveSchema } from "../src/server/schema.ts";

test("PostgreSQL staging inspects a consistent SQLite copy and every referenced original", () => {
  const dir = mkdtempSync(join(tmpdir(), "drevo-pg-stage-"));
  try {
    const sqlite = join(dir, "archive-copy.sqlite");
    const uploads = join(dir, "uploads");
    mkdirSync(uploads);
    writeFileSync(join(uploads, "photo.jpg"), "image");
    writeFileSync(join(uploads, "record.pdf"), "document");
    const db = new DatabaseSync(sqlite);
    try {
      initializeArchiveSchema(db);
      db.prepare(
        "INSERT INTO archive(id,title,description,demo,revision) VALUES(1,?,?,0,?)",
      ).run("Архив", "Описание", 3);
      db.prepare("INSERT INTO people(id,data) VALUES(?,?)").run(
        "person-1",
        JSON.stringify({ id: "person-1", photo: "/media/photo.jpg" }),
      );
      db.prepare("INSERT INTO photos(id,data) VALUES(?,?)").run(
        "photo-1",
        JSON.stringify({ id: "photo-1", url: "/media/photo.jpg" }),
      );
      db.prepare(
        "INSERT INTO media_originals(url,size_bytes,uploaded_by,created_at) VALUES(?,?,?,?)",
      ).run("/media/photo.jpg", 5, "user-1", "2026-09-27T00:00:00Z");
      db.prepare(
        "INSERT INTO documents(id,title,title_search,file_name,file_size,uploaded_by,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        "document-1",
        "Запись",
        "запись",
        "record.pdf",
        8,
        "user-1",
        "2026-09-27T00:00:00Z",
      );
      db.prepare(
        "INSERT INTO document_people(document_id,person_id) VALUES(?,?)",
      ).run("document-1", "person-1");
      db.prepare(
        "INSERT INTO person_comments(person_id,author_id,created_ms,text) VALUES(?,?,?,?)",
      ).run("person-1", "user-1", 1_000, "Воспоминание");
      db.prepare("INSERT INTO users(id,name,role) VALUES(?,?,?)").run(
        "user-1",
        "Участник",
        "relative",
      );
      db.prepare(
        "INSERT INTO user_tree_preferences(user_id,reverse_timeline,card_variant) VALUES(?,?,?)",
      ).run("user-1", 1, "portrait");
      db.prepare(
        "INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
      ).run("session-hash", "user-1", 1_000);
      db.prepare(
        "INSERT INTO ai_chats(id,user_id,access_scope) VALUES(?,?,?)",
      ).run("chat-1", "user-1", "all");
      db.prepare(
        "INSERT INTO ai_chat_messages(chat_id,role,content) VALUES(?,?,?)",
      ).run("chat-1", "user", "Кто мой предок?");
    } finally {
      db.close();
    }
    const before = readFileSync(sqlite);
    const snapshot = inspectSqliteSnapshot(sqlite, uploads);
    assert.equal(snapshot.archive.revision, 3);
    assert.equal(snapshot.rows.get("people")?.length, 1);
    assert.equal(snapshot.rows.get("documents")?.length, 1);
    assert.equal(snapshot.rows.get("document_people")?.length, 1);
    assert.equal(snapshot.rows.get("person_comments")?.length, 1);
    assert.equal(snapshot.services.length, 31);
    assert.equal(
      snapshot.services.find((table) => table.name === "media_originals")
        ?.rows[0]?.data.size_bytes,
      5,
    );
    assert.ok(
      snapshot.services.some((table) => table.name === "share_link_activity"),
    );
    assert.equal(
      snapshot.services.find((table) => table.name === "user_tree_preferences")
        ?.rows[0]?.data.card_variant,
      "portrait",
    );
    assert.equal(
      snapshot.services.find((table) => table.name === "users")?.rows[0]?.data
        .name,
      "Участник",
    );
    assert.equal(
      snapshot.services.find((table) => table.name === "auth_sessions")?.rows[0]
        ?.data.token_hash,
      "session-hash",
    );
    assert.equal(
      snapshot.services.find((table) => table.name === "ai_chat_messages")
        ?.rows[0]?.data.content,
      "Кто мой предок?",
    );
    assert.deepEqual(snapshot.media, { local: 2, external: 0 });
    assert.deepEqual(
      readFileSync(sqlite),
      before,
      "исходная копия не меняется",
    );
    writeFileSync(join(uploads, "record.pdf"), "short");
    assert.throws(
      () => inspectSqliteSnapshot(sqlite, uploads),
      /Размер оригинала документа не совпал/,
    );
    rmSync(join(uploads, "record.pdf"));
    assert.throws(
      () => inspectSqliteSnapshot(sqlite, uploads),
      /Не найдены оригиналы файлов: 1/,
    );
    assert.throws(
      () => inspectSqliteSnapshot(join(dir, "drevo.sqlite"), uploads),
      /согласованную копию SQLite/,
    );
    writeFileSync(join(uploads, "record.pdf"), "document");
    const oldSchema = new DatabaseSync(sqlite);
    oldSchema.exec("DROP TABLE person_comments");
    for (const column of ["document_type", "document_date", "place", "description", "provenance"])
      oldSchema.exec(`ALTER TABLE documents DROP COLUMN ${column}`);
    oldSchema.close();
    assert.deepEqual(
      inspectSqliteSnapshot(sqlite, uploads).rows.get("person_comments"),
      [],
      "копии до появления обсуждений остаются переносимыми",
    );
    assert.equal(
      inspectSqliteSnapshot(sqlite, uploads).rows.get("documents")?.[0]?.provenance,
      "",
      "старые документы получают пустые дополнительные поля",
    );
    const futureSchema = new DatabaseSync(sqlite);
    futureSchema.exec(
      "CREATE TABLE unexpected_future_data (id TEXT PRIMARY KEY) STRICT",
    );
    futureSchema.close();
    assert.throws(
      () => inspectSqliteSnapshot(sqlite, uploads),
      /Неизвестная или отсутствующая таблица SQLite: unexpected_future_data/,
      "новые таблицы нельзя молча пропускать при миграции",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PostgreSQL access plan keeps roles and requires an unambiguous archive owner", () => {
  const users = [
    {
      id: "admin-1",
      name: "Администратор",
      role: "admin",
      approved: 1,
      created_at: "2026-01-01T00:00:00Z",
      last_visit_at: null,
      person_id: null,
      tree_access: "all",
    },
    {
      id: "reader-1",
      name: "Читатель",
      role: "reader",
      approved: 1,
      created_at: "2026-01-02T00:00:00Z",
      last_visit_at: "2026-09-27T00:00:00Z",
      person_id: "person-1",
      tree_access: "common_ancestors",
    },
  ];
  const plan = planArchiveAccess(users);
  assert.equal(plan.ownerId, "admin-1");
  assert.deepEqual(plan.memberships[1], {
    user_id: "reader-1",
    role: "reader",
    approved: true,
    person_id: "person-1",
    tree_access: "common_ancestors",
  });
  assert.equal(plan.accounts[1].last_visit_at, "2026-09-27T00:00:00Z");
  assert.throws(() => planArchiveAccess(users.slice(1)), /ровно один/);
  assert.throws(() => planArchiveAccess([users[0], users[0]]), /ровно один/);
  assert.equal(
    planArchiveAccess([users[0], { ...users[0], id: "admin-2" }], "admin-2")
      .ownerId,
    "admin-2",
  );
  assert.throws(() => planArchiveAccess(users, "reader-1"), /владелец/);
  assert.throws(
    () => planArchiveAccess([{ ...users[0], approved: 2 }]),
    /Некорректное поле users.approved/,
  );
});
