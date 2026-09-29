import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ARCHIVE_SCHEMA_VERSION,
  initializeArchiveSchema,
} from "../src/server/schema.ts";

function userVersion(db: DatabaseSync) {
  return Number(db.prepare("PRAGMA user_version").get()!.user_version);
}

function columns(db: DatabaseSync, table: string) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

function tableNames(db: DatabaseSync) {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type='table'")
      .all()
      .map((row) => String(row.name)),
  );
}

test("visit extension preserves v18 rollback compatibility and unknown activity", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    db.exec(
      "ALTER TABLE users DROP COLUMN last_visit_at; DELETE FROM migrations WHERE id='2026-09-user-last-visit';",
    );
    db.prepare("INSERT INTO users(id,name,role) VALUES(?,?,?)").run(
      "existing",
      "Участник",
      "reader",
    );
    initializeArchiveSchema(db);
    assert.equal(
      userVersion(db),
      18,
      "previous deployed code must still open this database",
    );
    assert.equal(
      db.prepare("SELECT last_visit_at FROM users WHERE id='existing'").get()!
        .last_visit_at,
      null,
    );
    db.prepare("UPDATE users SET last_visit_at=? WHERE id='existing'").run(
      "2026-09-26T07:00:00.000Z",
    );
    initializeArchiveSchema(db);
    assert.equal(db.prepare("SELECT count(*) AS n FROM users").get()!.n, 1);
    assert.equal(
      db.prepare("SELECT last_visit_at FROM users WHERE id='existing'").get()!
        .last_visit_at,
      "2026-09-26T07:00:00.000Z",
    );
    // Inserts made by the preceding release omit this new nullable column.
    db.prepare("INSERT INTO users(id,name,role) VALUES(?,?,?)").run(
      "old-code",
      "Участник",
      "reader",
    );
    assert.equal(
      db.prepare("SELECT last_visit_at FROM users WHERE id='old-code'").get()!
        .last_visit_at,
      null,
    );
  } finally {
    db.close();
  }
});

test("fresh SQLite archive gets current schema version", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    assert.equal(userVersion(db), ARCHIVE_SCHEMA_VERSION);
    assert.ok(columns(db, "relations").includes("created_by"));
    assert.ok(columns(db, "ai_settings").includes("enabled"));
    assert.ok(columns(db, "ai_settings").includes("daily_tokens"));
    assert.ok(columns(db, "ai_settings").includes("api_key_ciphertext"));
    assert.ok(columns(db, "ai_settings").includes("folder_id"));
    assert.ok(columns(db, "mcp_tokens").includes("rate_limit_per_minute"));
    assert.ok(columns(db, "mcp_tokens").includes("bound_user_id"));
    assert.ok(columns(db, "face_descriptors").includes("source_tag_id"));
    for (const field of ["document_type", "document_date", "place", "description", "provenance"])
      assert.ok(columns(db, "documents").includes(field));
    const tables = tableNames(db);
    for (const table of [
      "archive",
      "people",
      "relations",
      "photos",
      "photo_tags",
      "face_descriptors",
      "history",
      "users",
      "auth_sessions",
      "access_settings",
      "tree_settings",
      "user_tree_preferences",
      "audit_entries",
      "audit_people",
      "share_links",
      "geocode_cache",
      "migrations",
      "mcp_tokens",
      "research_suggestions",
      "ai_settings",
      "ai_usage",
      "ai_usage_models",
      "mcp_usage",
      "research_categories",
      "research_resources",
    ])
      assert.ok(tables.has(table), `missing table ${table}`);
    initializeArchiveSchema(db);
    assert.equal(userVersion(db), ARCHIVE_SCHEMA_VERSION);
  } finally {
    db.close();
  }
});

test("legacy version 0 relations table migrates through all schema versions", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE people (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL CHECK(json_valid(data))
      ) STRICT;
      CREATE TABLE relations (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        target TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('parent','spouse','adoptive_parent','godparent','nurse','sworn_sibling','guardian')),
        note TEXT NOT NULL DEFAULT '',
        CHECK(source<>target),
        UNIQUE(source,target,type)
      ) STRICT;
    `);
    assert.equal(userVersion(db), 0);
    assert.equal(columns(db, "relations").includes("created_by"), false);

    initializeArchiveSchema(db);

    assert.equal(userVersion(db), ARCHIVE_SCHEMA_VERSION);
    assert.equal(columns(db, "relations").includes("created_by"), true);
    assert.ok(tableNames(db).has("history"));
    assert.ok(tableNames(db).has("auth_sessions"));
  } finally {
    db.close();
  }
});

test("schema v3 preserves relationships and authors while enabling step-parents", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    db.exec(`
      DROP TABLE relations;
      CREATE TABLE relations (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        target TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('parent','spouse','adoptive_parent','godparent','nurse','sworn_sibling','guardian')),
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT,
        CHECK(source<>target),
        UNIQUE(source,target,type)
      ) STRICT;
      CREATE INDEX relations_target ON relations(target);
      INSERT INTO people(id,data) VALUES ('adult','{}'),('child','{}');
      INSERT INTO relations(id,source,target,type,note,created_by)
        VALUES ('old','adult','child','godparent','запись','author');
      PRAGMA user_version=3;
    `);
    initializeArchiveSchema(db);
    assert.equal(userVersion(db), ARCHIVE_SCHEMA_VERSION);
    assert.deepEqual(
      {
        ...db
          .prepare(
            "SELECT id,source,target,type,note,created_by FROM relations",
          )
          .get(),
      },
      {
        id: "old",
        source: "adult",
        target: "child",
        type: "godparent",
        note: "запись",
        created_by: "author",
      },
    );
    db.prepare(
      "INSERT INTO relations(id,source,target,type) VALUES ('step','adult','child','step_parent')",
    ).run();
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.ok(
      db
        .prepare(
          "SELECT 1 FROM sqlite_schema WHERE type='index' AND name='relations_target'",
        )
        .get(),
    );
  } finally {
    db.close();
  }
});

test("schema v1 upgrades service tables to v2 without losing existing users", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','relative','reader')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT;
      INSERT INTO users(id,name,role) VALUES('legacy-user','Старый пользователь','admin');
      PRAGMA user_version=1;
    `);

    initializeArchiveSchema(db);

    assert.equal(userVersion(db), ARCHIVE_SCHEMA_VERSION);
    assert.equal(
      String(
        db.prepare("SELECT name FROM users WHERE id='legacy-user'").get()!.name,
      ),
      "Старый пользователь",
    );
    const tables = tableNames(db);
    for (const table of [
      "auth_sessions",
      "access_settings",
      "tree_settings",
      "audit_entries",
      "audit_people",
      "share_links",
      "geocode_cache",
      "migrations",
    ])
      assert.ok(tables.has(table), `missing table ${table}`);
  } finally {
    db.close();
  }
});

test("failed migration rolls back its DDL and keeps the previous version", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','relative','reader')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT;
      CREATE TABLE audit_entries (id INTEGER PRIMARY KEY) STRICT;
      PRAGMA user_version=1;
    `);

    assert.throws(() => initializeArchiveSchema(db));

    assert.equal(userVersion(db), 1);
    const objects = new Map(
      db
        .prepare(
          "SELECT name,type FROM sqlite_schema WHERE name IN ('auth_sessions','access_settings','audit_entries')",
        )
        .all()
        .map((row) => [String(row.name), String(row.type)]),
    );
    assert.equal(objects.has("auth_sessions"), false);
    assert.equal(objects.has("access_settings"), false);
    assert.equal(objects.get("audit_entries"), "table");
  } finally {
    db.close();
  }
});

test("schema v14 binds valid face descriptors to tags and removes stale corrections", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    db.exec(`
      DROP TRIGGER IF EXISTS face_descriptor_tag_update;
      DROP TABLE face_descriptors;
      CREATE TABLE face_descriptors (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        data TEXT NOT NULL CHECK(json_valid(data)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        created_by TEXT,
        source_photo_id TEXT,
        model TEXT NOT NULL DEFAULT 'face-api-1.7.15'
      ) STRICT;
      CREATE INDEX face_descriptors_person ON face_descriptors(person_id);

      INSERT INTO people(id,data) VALUES
        ('first','{}'),
        ('second','{}');
      INSERT INTO photos(id,data) VALUES ('photo','{}');
      INSERT INTO photo_tags(id,photo_id,person_id,data) VALUES
        ('photo:tag-first','photo','first','{"id":"tag-first","personId":"first","x":0,"y":0,"width":1,"height":1}');
      INSERT INTO face_descriptors(
        id,person_id,data,source_photo_id,model
      ) VALUES
        ('valid','first','[0.1]','photo','human-faceres-3.3.6'),
        ('stale','second','[0.2]','photo','human-faceres-3.3.6');
      PRAGMA user_version=13;
    `);

    initializeArchiveSchema(db);

    assert.equal(userVersion(db), ARCHIVE_SCHEMA_VERSION);
    assert.deepEqual(
      db
        .prepare(
          "SELECT id,person_id,source_photo_id,source_tag_id FROM face_descriptors ORDER BY id",
        )
        .all()
        .map((row) => ({ ...row })),
      [
        {
          id: "valid",
          person_id: "first",
          source_photo_id: "photo",
          source_tag_id: "photo:tag-first",
        },
      ],
    );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    db.close();
  }
});

test("future schema version is rejected without changing the database", () => {
  const directory = mkdtempSync(join(tmpdir(), "drevo-schema-test-")),
    file = join(directory, "future.sqlite"),
    future = ARCHIVE_SCHEMA_VERSION + 1;
  try {
    const db = new DatabaseSync(file);
    db.exec(`PRAGMA user_version=${future}`);
    db.close();

    const reopened = new DatabaseSync(file);
    try {
      assert.throws(
        () => initializeArchiveSchema(reopened),
        /более новой версией Drevo/,
      );
      assert.equal(userVersion(reopened), future);
      assert.equal(
        reopened
          .prepare(
            "SELECT count(*) AS n FROM sqlite_schema WHERE name='archive'",
          )
          .get()!.n,
        0,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
