import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeDatabaseBackup } from "../../src/server/backup.ts";
import { sanitizeTreeBackup } from "../../src/server/tree-backup-files.ts";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { verifyPortableSchema } from "./postgres-portable-schema.ts";

export async function verifyPortablePublicationBackup(db: StoreDatabase, directory: string,
  personId: string, foreignPersonId: string) {
  await verifyPortableSchema(db);
  const fields = ["birth_year_visible", "death_year_visible", "birth_place_visible",
    "death_place_visible", "birth_surname_visible"];
  const before = await db.prepare("", `SELECT ${fields.join(",")} FROM published_people WHERE person_id=?`).get(personId);
  assert.ok(before);
  assert.ok(fields.every(field => typeof before[field] === "boolean"), "exercise actual PostgreSQL boolean values");
  const file = join(directory, `published-backup-${randomUUID()}.sqlite`);
  try {
    await writeDatabaseBackup(db, file);
    sanitizeTreeBackup(file);
    const saved = new DatabaseSync(file, { readOnly: true });
    try {
      const row = saved.prepare(`SELECT ${fields.join(",")} FROM published_people WHERE person_id=?`).get(personId);
      assert.ok(row);
      for (const field of fields) assert.equal(row[field], Number(before[field]));
      assert.equal(saved.prepare("SELECT count(*) AS n FROM published_people WHERE person_id=?").get(foreignPersonId)!.n, 0);
      assert.equal(saved.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
      assert.deepEqual(saved.prepare("PRAGMA foreign_key_check").all(), []);
      for (const table of ["auth_sessions", "mcp_tokens", "ai_chats", "ai_chat_messages", "ai_settings"])
        if (saved.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table))
          assert.equal(saved.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n, 0);
    } finally { saved.close(); }
  } finally { await rm(file, { force: true }); }
}
