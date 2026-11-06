import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import {
  portableSnapshotSchema,
  portableSnapshotValue,
} from "../src/server/portable-snapshot-schema.ts";

test("the portable plan covers current and optional legacy tables, excludes platform credentials and masks provider context", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    // This platform-owned table exists only in some historical snapshots.
    db.exec("CREATE TABLE IF NOT EXISTS platform_ai_input_files(id TEXT)");
    const schema = portableSnapshotSchema(db);
    const expected = db
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all();
    assert.deepEqual(
      schema.map((table) => table.name),
      expected.map((table) => table.name),
    );
    assert.deepEqual(
      schema
        .filter((table) => table.select === null)
        .map((table) => table.name),
      [
        "platform_ai_cleanup_keys",
        "platform_ai_conversations",
        "platform_ai_input_files",
      ],
    );
    const chats = schema.find((table) => table.name === "ai_chats")!;
    assert.match(chats.select!, /NULL AS "yandex_conversation_id"/);
    assert.match(chats.select!, /NULL AS "provider_cleanup_ref"/);
    assert.match(
      schema.find((table) => table.name === "media_storage_usage")!.select!,
      /FROM media_originals/,
    );
  } finally {
    db.close();
  }
});

test("the bridge handles driver values explicitly instead of stringifying objects or changing boolean column meaning", () => {
  const integer = { name: "visible", type: "INTEGER" };
  const text = { name: "data", type: "TEXT" };
  assert.equal(portableSnapshotValue("published_people", integer, true), 1);
  assert.equal(portableSnapshotValue("published_people", integer, false), 0);
  assert.equal(
    portableSnapshotValue("people", text, '{"name":"saved"}'),
    '{"name":"saved"}',
  );
  const bytes = Buffer.from([0, 1, 255]);
  assert.equal(
    portableSnapshotValue("binary", { name: "payload", type: "BLOB" }, bytes),
    bytes,
  );
  for (const value of [true, { private: "value" }, bytes])
    assert.throws(
      () => portableSnapshotValue("people", text, value),
      /Некорректное поле копии: people.data/,
    );
});
