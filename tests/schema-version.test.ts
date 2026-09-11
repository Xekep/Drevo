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

test("fresh SQLite archive gets current schema version", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    assert.equal(userVersion(db), ARCHIVE_SCHEMA_VERSION);
    assert.ok(columns(db, "relations").includes("created_by"));
    const tables = tableNames(db);
    for (const table of [
      "archive",
      "people",
      "relations",
      "photos",
      "photo_tags",
      "history",
      "users",
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
      String(db.prepare("SELECT name FROM users WHERE id='legacy-user'").get()!.name),
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
          .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='archive'")
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
