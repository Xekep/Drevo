import type { DatabaseSync } from "node:sqlite";

export const ARCHIVE_SCHEMA_VERSION = 2;

const coreSchema = `
CREATE TABLE IF NOT EXISTS archive (
  id INTEGER PRIMARY KEY CHECK(id=1),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  demo INTEGER NOT NULL,
  revision INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
CREATE TABLE IF NOT EXISTS relations (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK(type IN ('parent','spouse','adoptive_parent','godparent','nurse','sworn_sibling','guardian')),
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  CHECK(source<>target),
  UNIQUE(source,target,type)
) STRICT;
CREATE INDEX IF NOT EXISTS relations_target ON relations(target);
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
CREATE TABLE IF NOT EXISTS photo_tags (
  id TEXT PRIMARY KEY,
  photo_id TEXT NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
CREATE INDEX IF NOT EXISTS photo_tags_person ON photo_tags(person_id);
CREATE TABLE IF NOT EXISTS history (
  revision INTEGER PRIMARY KEY,
  saved_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  data TEXT NOT NULL CHECK(json_valid(data))
) STRICT;
`;

const serviceSchema = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','relative','reader')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
CREATE TABLE IF NOT EXISTS access_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  public_tree INTEGER NOT NULL CHECK(public_tree IN (0,1)),
  public_albums INTEGER NOT NULL CHECK(public_albums IN (0,1))
) STRICT;
CREATE TABLE IF NOT EXISTS tree_settings (
  id INTEGER PRIMARY KEY CHECK(id=1),
  reverse_timeline INTEGER NOT NULL DEFAULT 0 CHECK(reverse_timeline IN (0,1))
) STRICT;
CREATE TABLE IF NOT EXISTS audit_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  label TEXT NOT NULL,
  revision INTEGER,
  details TEXT NOT NULL CHECK(json_valid(details))
) STRICT;
CREATE TABLE IF NOT EXISTS audit_people (
  entry_id INTEGER NOT NULL REFERENCES audit_entries(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL,
  PRIMARY KEY(entry_id,person_id)
) STRICT;
CREATE INDEX IF NOT EXISTS audit_people_person ON audit_people(person_id,entry_id);
CREATE INDEX IF NOT EXISTS audit_actor ON audit_entries(actor_id,id);
CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  anchor_id TEXT NOT NULL,
  person_ids TEXT NOT NULL CHECK(json_valid(person_ids)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_name TEXT NOT NULL,
  revoked_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS geocode_cache (
  query TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  saved_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS migrations (
  id TEXT PRIMARY KEY
) STRICT;
`;

function version(db: DatabaseSync) {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
}

function relationHasCreatedBy(db: DatabaseSync) {
  return db
    .prepare("PRAGMA table_info(relations)")
    .all()
    .some((row) => row.name === "created_by");
}

function migrate(db: DatabaseSync, target: number) {
  if (target === 1) {
    db.exec(coreSchema);
    // Legacy-базы до schema v1 создавали relations без created_by.
    if (!relationHasCreatedBy(db))
      db.exec("ALTER TABLE relations ADD COLUMN created_by TEXT");
    return;
  }
  if (target === 2) {
    db.exec(serviceSchema);
    return;
  }
  throw new Error(`Нет миграции SQLite до версии ${target}`);
}

export function initializeArchiveSchema(db: DatabaseSync) {
  const current = version(db);
  if (!Number.isInteger(current) || current < 0)
    throw new Error("Некорректная версия схемы SQLite");
  if (current > ARCHIVE_SCHEMA_VERSION)
    throw new Error(
      `База создана более новой версией Drevo (схема ${current}, поддерживается ${ARCHIVE_SCHEMA_VERSION})`,
    );

  // Эти PRAGMA относятся к текущему соединению. Проверка future-version выше
  // намеренно выполняется первой, чтобы незнакомую базу не менять вообще.
  db.exec(
    "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
  );

  for (let target = current + 1; target <= ARCHIVE_SCHEMA_VERSION; target++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      migrate(db, target);
      db.exec(`PRAGMA user_version=${target}; COMMIT;`);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
