import type { DatabaseSync } from "node:sqlite";
import { researchCatalogSeed } from "./research-catalog-seed.ts";

export const ARCHIVE_SCHEMA_VERSION = 18;

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

function tableHasColumn(db: DatabaseSync, table: string, column: string) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function relationHasCreatedBy(db: DatabaseSync) {
  return tableHasColumn(db, "relations", "created_by");
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
  if (target === 9) {
    if (!tableHasColumn(db, "ai_settings", "requests_per_minute"))
      db.exec(`
        ALTER TABLE ai_settings ADD COLUMN requests_per_minute INTEGER NOT NULL DEFAULT 6
          CHECK(requests_per_minute BETWEEN 0 AND 120);
      `);
    if (!tableHasColumn(db, "ai_settings", "daily_requests"))
      db.exec(`
        ALTER TABLE ai_settings ADD COLUMN daily_requests INTEGER NOT NULL DEFAULT 100
          CHECK(daily_requests BETWEEN 0 AND 100000);
      `);
    if (!tableHasColumn(db, "ai_settings", "daily_tokens"))
      db.exec(`
        ALTER TABLE ai_settings ADD COLUMN daily_tokens INTEGER NOT NULL DEFAULT 250000
          CHECK(daily_tokens BETWEEN 0 AND 1000000000);
      `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        started_ms INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('ok','error')),
        provider_calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ai_usage_user_started
        ON ai_usage(user_id,started_ms DESC);
      CREATE INDEX IF NOT EXISTS ai_usage_started
        ON ai_usage(started_ms DESC);
    `);
    return;
  }
  if (target === 10) {
    if (!tableHasColumn(db, "mcp_tokens", "rate_limit_per_minute"))
      db.exec(`
        ALTER TABLE mcp_tokens
          ADD COLUMN rate_limit_per_minute INTEGER NOT NULL DEFAULT 60
          CHECK(rate_limit_per_minute BETWEEN 0 AND 600);
      `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        started_ms INTEGER NOT NULL,
        token_id TEXT NOT NULL REFERENCES mcp_tokens(id) ON DELETE CASCADE,
        method TEXT NOT NULL,
        tool_name TEXT,
        status TEXT NOT NULL CHECK(status IN ('ok','error')),
        latency_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS mcp_usage_token_started
        ON mcp_usage(token_id,started_ms DESC);
      CREATE INDEX IF NOT EXISTS mcp_usage_started
        ON mcp_usage(started_ms DESC);
    `);
    return;
  }
  if (target === 11) {
    if (!tableHasColumn(db, "mcp_tokens", "bound_user_id"))
      db.exec(`
        ALTER TABLE mcp_tokens
          ADD COLUMN bound_user_id TEXT REFERENCES users(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS mcp_tokens_bound_user
          ON mcp_tokens(bound_user_id);
      `);
    return;
  }
  if (target === 12) {
    if (!tableHasColumn(db, "ai_settings", "api_key_ciphertext"))
      db.exec(`
        ALTER TABLE ai_settings
          ADD COLUMN api_key_ciphertext TEXT NOT NULL DEFAULT '';
      `);
    if (!tableHasColumn(db, "ai_settings", "folder_id"))
      db.exec(`
        ALTER TABLE ai_settings
          ADD COLUMN folder_id TEXT NOT NULL DEFAULT '';
      `);
    return;
  }
  if (target === 13) {
    db.exec(`
      DROP TABLE IF EXISTS research_suggestions_v13;
      CREATE TABLE research_suggestions_v13 (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('person_create','person_update','source','relation')),
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
      INSERT INTO research_suggestions_v13(
        id,kind,status,person_id,payload,reason,evidence,base_revision,
        created_at,created_by,reviewed_at,reviewed_by
      )
        SELECT
          id,kind,status,person_id,payload,reason,evidence,base_revision,
          created_at,created_by,reviewed_at,reviewed_by
        FROM research_suggestions;
      DROP TABLE research_suggestions;
      ALTER TABLE research_suggestions_v13 RENAME TO research_suggestions;
      CREATE INDEX research_suggestions_status
        ON research_suggestions(status,created_at DESC);
      CREATE INDEX research_suggestions_creator
        ON research_suggestions(created_by,status);
    `);
    return;
  }
  if (target === 14) {
    // Fresh databases reach v14 before the older provenance extension runs.
    // In that case only add the nullable tag reference; the extension below
    // will add created_by/source_photo_id/model afterwards.
    if (!tableHasColumn(db, "face_descriptors", "source_photo_id")) {
      db.exec(`
        ALTER TABLE face_descriptors
          ADD COLUMN source_tag_id TEXT REFERENCES photo_tags(id) ON DELETE CASCADE;
        CREATE INDEX IF NOT EXISTS face_descriptors_source_tag
          ON face_descriptors(source_tag_id);
      `);
      return;
    }

    // Existing descriptors only knew the source photo. Bind them to a current
    // confirmed tag where possible and drop orphaned samples left by corrected
    // or removed photo annotations.
    db.exec(`
      DROP TRIGGER IF EXISTS face_descriptor_tag_update;
      DROP TABLE IF EXISTS face_descriptors_v14;
      CREATE TABLE face_descriptors_v14 (
        id TEXT PRIMARY KEY,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        data TEXT NOT NULL CHECK(json_valid(data)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        created_by TEXT,
        source_photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE,
        source_tag_id TEXT REFERENCES photo_tags(id) ON DELETE CASCADE,
        model TEXT NOT NULL DEFAULT 'face-api-1.7.15'
      ) STRICT;
      INSERT INTO face_descriptors_v14(
        id,person_id,data,created_at,created_by,source_photo_id,source_tag_id,model
      )
      SELECT
        d.id,d.person_id,d.data,d.created_at,d.created_by,d.source_photo_id,
        CASE
          WHEN d.source_photo_id IS NULL THEN NULL
          ELSE (
            SELECT pt.id
              FROM photo_tags pt
             WHERE pt.photo_id=d.source_photo_id
               AND pt.person_id=d.person_id
             ORDER BY pt.rowid
             LIMIT 1
          )
        END,
        d.model
      FROM face_descriptors d
      WHERE d.source_photo_id IS NULL
         OR EXISTS (
           SELECT 1
             FROM photo_tags pt
            WHERE pt.photo_id=d.source_photo_id
              AND pt.person_id=d.person_id
         );
      DROP TABLE face_descriptors;
      ALTER TABLE face_descriptors_v14 RENAME TO face_descriptors;
      CREATE INDEX face_descriptors_person ON face_descriptors(person_id);
      CREATE INDEX face_descriptors_source_tag ON face_descriptors(source_tag_id);
    `);
    return;
  }
  if (target === 15) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_usage_models (
        usage_id INTEGER NOT NULL REFERENCES ai_usage(id) ON DELETE CASCADE,
        model TEXT NOT NULL,
        provider_calls INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        total_tokens INTEGER NOT NULL,
        PRIMARY KEY(usage_id,model)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ai_usage_models_model
        ON ai_usage_models(model,usage_id);
      INSERT OR IGNORE INTO ai_usage_models(
        usage_id,model,provider_calls,input_tokens,output_tokens,total_tokens
      )
        SELECT id,model,provider_calls,input_tokens,output_tokens,total_tokens
        FROM ai_usage
        WHERE provider_calls>0 OR total_tokens>0;
    `);
    return;
  }
  if (target === 16) {
    for (const [table, column, sql] of [
      [
        "ai_settings",
        "compaction_enabled",
        "INTEGER NOT NULL DEFAULT 1 CHECK(compaction_enabled IN (0,1))",
      ],
      [
        "ai_settings",
        "compact_threshold_tokens",
        "INTEGER NOT NULL DEFAULT 32000 CHECK(compact_threshold_tokens BETWEEN 1000 AND 1000000)",
      ],
      [
        "ai_settings",
        "automatic_truncation",
        "INTEGER NOT NULL DEFAULT 1 CHECK(automatic_truncation IN (0,1))",
      ],
      [
        "ai_settings",
        "max_tool_iterations",
        "INTEGER NOT NULL DEFAULT 8 CHECK(max_tool_iterations BETWEEN 1 AND 20)",
      ],
      ["ai_usage", "cached_input_tokens", "INTEGER NOT NULL DEFAULT 0"],
    ])
      if (!tableHasColumn(db, table, column))
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sql}`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ai_chats (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        access_scope TEXT NOT NULL,
        yandex_conversation_id TEXT,
        session_state TEXT NOT NULL DEFAULT '{"schemaVersion":1,"activePersonIds":[]}'
          CHECK(json_valid(session_state)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        busy_token TEXT,
        busy_until INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ai_chats_user_updated ON ai_chats(user_id,updated_at DESC);
      CREATE TRIGGER IF NOT EXISTS ai_chats_user_delete AFTER DELETE ON users
        BEGIN DELETE FROM ai_chats WHERE user_id=OLD.id; END;
      CREATE TABLE IF NOT EXISTS ai_chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL REFERENCES ai_chats(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant')),
        content TEXT NOT NULL,
        data TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(data)),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ) STRICT;
      CREATE INDEX IF NOT EXISTS ai_chat_messages_chat_id ON ai_chat_messages(chat_id,id);
    `);
    return;
  }
  if (target === 17) {
    const existingCatalog = db
      .prepare(
        "SELECT 1 FROM sqlite_schema WHERE type='table' AND name='research_categories'",
      )
      .get();
    db.exec(`
      CREATE TABLE IF NOT EXISTS research_categories (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        sort_order INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS research_resources (
        id TEXT PRIMARY KEY,
        category_id TEXT NOT NULL REFERENCES research_categories(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        description TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        UNIQUE(category_id,url)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS research_resources_category_order
        ON research_resources(category_id,sort_order,id);
    `);
    if (existingCatalog) return;
    const category = db.prepare(
      "INSERT INTO research_categories(id,name,sort_order) VALUES(?,?,?)",
    );
    const resource = db.prepare(
      "INSERT INTO research_resources(id,category_id,name,url,description,sort_order) VALUES(?,?,?,?,?,?)",
    );
    for (const [categoryIndex, group] of researchCatalogSeed.entries()) {
      const categoryId = `seed-category-${categoryIndex}`;
      category.run(categoryId, group.name, categoryIndex);
      for (const [resourceIndex, item] of group.resources.entries())
        resource.run(
          `seed-resource-${categoryIndex}-${resourceIndex}`,
          categoryId,
          item.name,
          item.url,
          item.description,
          resourceIndex,
        );
    }
    return;
  }
  if (target === 18) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        title_search TEXT NOT NULL,
        file_name TEXT NOT NULL UNIQUE,
        file_size INTEGER NOT NULL CHECK(file_size>0),
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS documents_created ON documents(created_at DESC,id DESC);
      CREATE TABLE IF NOT EXISTS document_people (
        document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
        person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
        PRIMARY KEY(document_id,person_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS document_people_person ON document_people(person_id,document_id);
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
        ALTER TABLE face_descriptors ADD COLUMN source_photo_id TEXT REFERENCES photos(id) ON DELETE CASCADE;
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
  if (
    tableHasColumn(db, "face_descriptors", "source_tag_id") &&
    tableHasColumn(db, "face_descriptors", "source_photo_id")
  )
    db.exec(`
      DROP TRIGGER IF EXISTS face_descriptor_tag_person_update;
      DROP TRIGGER IF EXISTS face_descriptor_tag_update;
      CREATE TRIGGER face_descriptor_tag_update
      AFTER UPDATE OF person_id, photo_id ON photo_tags
      BEGIN
        UPDATE face_descriptors
           SET person_id=NEW.person_id,
               source_photo_id=NEW.photo_id
         WHERE source_tag_id=NEW.id;
      END;
    `);
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
  const storageExtension = "2026-09-upload-reservations-and-media-indexes";
  if (
    !db.prepare("SELECT 1 FROM migrations WHERE id=?").get(storageExtension)
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
    CREATE TABLE IF NOT EXISTS document_upload_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      started_ms INTEGER NOT NULL,
      expires_ms INTEGER NOT NULL,
      reserved_bytes INTEGER NOT NULL CHECK(reserved_bytes>=0)
    ) STRICT;
    CREATE INDEX IF NOT EXISTS document_upload_requests_user ON document_upload_requests(user_id,started_ms);
    CREATE INDEX IF NOT EXISTS media_photo_url ON photos(json_extract(data,'$.url'));
    CREATE INDEX IF NOT EXISTS media_person_photo ON people(json_extract(data,'$.photo'));
  `);
      db.prepare("INSERT INTO migrations(id) VALUES(?)").run(storageExtension);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const mediaGrantExtension = "2026-09-media-upload-provenance";
  if (
    !db.prepare("SELECT 1 FROM migrations WHERE id=?").get(mediaGrantExtension)
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`CREATE TABLE media_upload_grants (
        url TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        expires_ms INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX media_upload_grants_expiry ON media_upload_grants(expires_ms);`);
      db.prepare("INSERT INTO migrations(id) VALUES(?)").run(
        mediaGrantExtension,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}
