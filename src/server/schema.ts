import type { DatabaseSync } from "node:sqlite";

export const ARCHIVE_SCHEMA_VERSION = 1;

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

function version(db: DatabaseSync) {
  return Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
}

function relationHasCreatedBy(db: DatabaseSync) {
  return db
    .prepare("PRAGMA table_info(relations)")
    .all()
    .some((row) => row.name === "created_by");
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
  if (current === ARCHIVE_SCHEMA_VERSION) return;

  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(coreSchema);
    // Legacy-базы до schema v1 создавали relations без created_by.
    if (!relationHasCreatedBy(db))
      db.exec("ALTER TABLE relations ADD COLUMN created_by TEXT");
    db.exec(`PRAGMA user_version=${ARCHIVE_SCHEMA_VERSION}; COMMIT;`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
