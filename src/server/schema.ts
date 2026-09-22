import type { DatabaseSync } from "node:sqlite";

export const ARCHIVE_SCHEMA_VERSION = 8;

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
CREATE INDEX IF NOT EXISTS users_created_at_id ON users(created_at DESC,id DESC);
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
  if (target === 3) {
    db.exec(`
      CREATE TABLE face_descriptors (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        data TEXT NOT NULL CHECK(json_valid(data)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT;
      CREATE INDEX face_descriptors_person ON face_descriptors(person_id);
    `);
    return;
  }
  if (target === 4) {
    db.exec(coreSchema);
    db.exec(`
      CREATE TABLE relations_v4 (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        target TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        type TEXT NOT NULL CHECK(type IN ('parent','spouse','adoptive_parent','step_parent','godparent','nurse','sworn_sibling','guardian')),
        note TEXT NOT NULL DEFAULT '',
        created_by TEXT,
        CHECK(source<>target),
        UNIQUE(source,target,type)
      ) STRICT;
      INSERT INTO relations_v4(id,source,target,type,note,created_by)
        SELECT id,source,target,type,note,created_by FROM relations;
      DROP TABLE relations;
      ALTER TABLE relations_v4 RENAME TO relations;
      CREATE INDEX relations_target ON relations(target);
    `);
    return;
  }
  if (target === 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_tokens (
        id TEXT PRIMARY KEY,
        token_hash TEXT UNIQUE NOT NULL,
        token_hint TEXT NOT NULL,
        name TEXT NOT NULL,
        scopes TEXT NOT NULL CHECK(json_valid(scopes)),
        created_at TEXT NOT NULL,
        expires_at INTEGER,
        created_by TEXT NOT NULL,
        revoked_at TEXT,
        last_used_at INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS mcp_tokens_active ON mcp_tokens(revoked_at,expires_at);
    `);
    return;
  }
  if (target === 6) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_suggestions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('person_update')),
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
        person_id TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        reason TEXT NOT NULL,
        evidence TEXT NOT NULL CHECK(json_valid(evidence)),
        base_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS research_suggestions_status
        ON research_suggestions(status,created_at DESC);
      CREATE INDEX IF NOT EXISTS research_suggestions_creator
        ON research_suggestions(created_by,status);
    `);
    return;
  }
  if (target === 7) {
    db.exec(`
      DROP TABLE IF EXISTS research_suggestions_v7;
      CREATE TABLE research_suggestions_v7 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('person_update','source','relation')),
        status TEXT NOT NULL CHECK(status IN ('pending','accepted','rejected')),
        person_id TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)),
        reason TEXT NOT NULL,
        evidence TEXT NOT NULL CHECK(json_valid(evidence)),
        base_revision INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        reviewed_at TEXT,
        reviewed_by TEXT
      ) STRICT;
      INSERT INTO research_suggestions_v7(
        id,kind,status,person_id,payload,reason,evidence,base_revision,
        created_at,created_by,reviewed_at,reviewed_by
      )
        SELECT
          id,kind,status,person_id,payload,reason,evidence,base_revision,
          created_at,created_by,reviewed_at,reviewed_by
        FROM research_suggestions;
      DROP TABLE research_suggestions;
      ALTER TABLE research_suggestions_v7 RENAME TO research_suggestions;
      CREATE INDEX research_suggestions_status
        ON research_suggestions(status,created_at DESC);
      CREATE INDEX research_suggestions_creator
        ON research_suggestions(created_by,status);
    `);
    return;
  }
  if (target === 8) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        model TEXT NOT NULL DEFAULT ''
      ) STRICT;
      INSERT OR IGNORE INTO ai_settings(id,enabled,model) VALUES(1,1,'');
    `);
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
  const extension = "2026-09-access-media-index-face-provenance";
  if (!db.prepare("SELECT 1 FROM migrations WHERE id=?").get(extension)) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN approved INTEGER NOT NULL DEFAULT 1 CHECK(approved IN (0,1));
        ALTER TABLE face_descriptors ADD COLUMN created_by TEXT;
        ALTER TABLE face_descriptors ADD COLUMN source_photo_id TEXT;
        ALTER TABLE face_descriptors ADD COLUMN model TEXT NOT NULL DEFAULT 'face-api-1.7.15';
        CREATE TABLE oauth_transactions (
          state_hash TEXT PRIMARY KEY,
          verifier TEXT NOT NULL,
          expires_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX oauth_transactions_expiry ON oauth_transactions(expires_at);
      `);
      db.prepare("INSERT INTO migrations(id) VALUES(?)").run(extension);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (
    db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='photo_tags'",
      )
      .get()
  )
    db.exec(
      "CREATE INDEX IF NOT EXISTS photo_tags_photo ON photo_tags(photo_id)",
    );
  const workflowExtension = "2026-09-persistent-workflow-stages";
  if (
    !db.prepare("SELECT 1 FROM migrations WHERE id=?").get(workflowExtension)
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TABLE workflow_stages (
          token TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK(kind IN ('gedcom','restore')),
          actor_id TEXT NOT NULL,
          revision INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          data TEXT NOT NULL CHECK(json_valid(data)),
          directory TEXT,
          UNIQUE(kind, actor_id)
        ) STRICT;
        CREATE INDEX workflow_stages_expiry ON workflow_stages(expires_at);
      `);
      db.prepare("INSERT INTO migrations(id) VALUES(?)").run(workflowExtension);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const identityExtension = "2026-09-user-tree-identity-and-scope";
  if (
    !db.prepare("SELECT 1 FROM migrations WHERE id=?").get(identityExtension)
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        ALTER TABLE users ADD COLUMN person_id TEXT REFERENCES people(id) ON DELETE SET NULL;
        ALTER TABLE users ADD COLUMN tree_access TEXT NOT NULL DEFAULT 'all'
          CHECK(tree_access IN ('all','common_ancestors'));
        CREATE UNIQUE INDEX users_person_id ON users(person_id) WHERE person_id IS NOT NULL;
      `);
      db.prepare("INSERT INTO migrations(id) VALUES(?)").run(identityExtension);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
