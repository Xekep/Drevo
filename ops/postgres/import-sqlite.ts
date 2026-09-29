import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import { ARCHIVE_SCHEMA_VERSION } from "../../src/server/schema.ts";
import { backfillArchiveAccessInTransaction } from "./backfill-archive-access.ts";
import { backfillArchiveAuditInTransaction } from "./backfill-archive-audit.ts";
import { backfillRuntimeServicesInTransaction } from "./backfill-runtime-services.ts";

type Row = Record<string, unknown>;
type Table = {
  name: string;
  columns: string[];
  order: string;
  json?: string[];
  numbers?: string[];
  optional?: boolean;
};

// Имена таблиц и столбцов заданы кодом, в SQL из параметров CLI они не попадают.
const tables: Table[] = [
  {
    name: "people",
    columns: ["ordinal", "id", "data"],
    order: "ordinal",
    json: ["data"],
    numbers: ["ordinal"],
  },
  {
    name: "photos",
    columns: ["ordinal", "id", "data"],
    order: "ordinal",
    json: ["data"],
    numbers: ["ordinal"],
  },
  {
    name: "relations",
    columns: [
      "ordinal",
      "id",
      "source",
      "target",
      "type",
      "note",
      "created_by",
    ],
    order: "ordinal",
    numbers: ["ordinal"],
  },
  {
    name: "photo_tags",
    columns: ["ordinal", "id", "photo_id", "person_id", "data"],
    order: "ordinal",
    json: ["data"],
    numbers: ["ordinal"],
  },
  {
    name: "documents",
    columns: [
      "ordinal",
      "id",
      "title",
      "title_search",
      "file_name",
      "file_size",
      "uploaded_by",
      "created_at",
      "annotations",
    ],
    order: "ordinal",
    numbers: ["ordinal", "file_size"],
  },
  {
    name: "document_people",
    columns: ["ordinal", "document_id", "person_id"],
    order: "ordinal",
    numbers: ["ordinal"],
  },
  {
    name: "history",
    columns: ["revision", "saved_at", "data"],
    order: "revision",
    json: ["data"],
    numbers: ["revision"],
  },
  {
    name: "person_comments",
    columns: ["id", "person_id", "author_id", "created_ms", "text"],
    order: "id",
    numbers: ["id", "created_ms"],
    optional: true,
  },
];

// These tables still need dedicated PostgreSQL repositories before cutover. Keep
// their complete rows in the shadow database so no account or service state is
// silently lost while those repositories are built.
const serviceTables = [
  "access_settings",
  "ai_chat_messages",
  "ai_chats",
  "ai_settings",
  "ai_usage",
  "ai_usage_models",
  "audit_entries",
  "audit_people",
  "auth_sessions",
  "backup_catalog",
  "backup_job",
  "backup_settings",
  "document_upload_requests",
  "face_descriptors",
  "geocode_cache",
  "mcp_tokens",
  "mcp_usage",
  "media_originals",
  "media_upload_grants",
  "migrations",
  "oauth_transactions",
  "research_categories",
  "research_resources",
  "research_suggestions",
  "share_links",
  "share_link_activity",
  "tree_settings",
  "user_tree_preferences",
  "users",
  "workflow_stages",
  "vk_auth_settings",
] as const;

type ServiceTable = {
  name: string;
  columns: string[];
  rows: Array<{ ordinal: number; data: Row }>;
};

function sqliteServiceTables(db: DatabaseSync): ServiceTable[] {
  const actual = db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all()
    .map((row) => String(row.name));
  const expected = [
    "archive",
    ...tables.map((table) => table.name),
    ...serviceTables,
  ]
    .filter(
      (name) =>
        !["person_comments", "vk_auth_settings", "media_originals"].includes(
          name,
        ) || actual.includes(name),
    )
    .sort();
  if (!isDeepStrictEqual(actual, expected))
    throw new Error(
      `Неизвестная или отсутствующая таблица SQLite: ${actual
        .filter((name) => !expected.includes(name))
        .concat(expected.filter((name) => !actual.includes(name)))
        .join(", ")}`,
    );
  for (const table of tables) {
    if (table.optional && !actual.includes(table.name)) continue;
    const columns = db
      .prepare(`PRAGMA table_info(${table.name})`)
      .all()
      .map((row) => String(row.name));
    const imported = table.columns.filter((column) => column !== "ordinal");
    if (!isDeepStrictEqual(columns, imported))
      throw new Error(`Столбцы ${table.name} отличаются от схемы импорта`);
  }
  const archiveColumns = db
    .prepare("PRAGMA table_info(archive)")
    .all()
    .map((row) => String(row.name));
  if (
    !isDeepStrictEqual(archiveColumns, [
      "id",
      "title",
      "description",
      "demo",
      "revision",
    ])
  )
    throw new Error("Столбцы archive отличаются от схемы импорта");
  return serviceTables.map((name) => {
    // Older standalone backups predate the additive VK settings table.
    if (name === "vk_auth_settings" && !actual.includes(name))
      return { name, columns: ["id", "enabled", "client_id"], rows: [] };
    if (name === "media_originals" && !actual.includes(name))
      return {
        name,
        columns: ["url", "size_bytes", "uploaded_by", "created_at"],
        rows: [],
      };
    const columns = db
      .prepare(`PRAGMA table_info(${name})`)
      .all()
      .map((row) => String(row.name));
    if (!columns.length)
      throw new Error(`Нет столбцов служебной таблицы ${name}`);
    const rows = db
      .prepare(`SELECT rowid AS ordinal,* FROM ${name} ORDER BY rowid`)
      .all()
      .map((row) => ({
        ordinal: Number(row.ordinal),
        data: Object.fromEntries(
          columns.map((column) => [column, row[column]]),
        ),
      }));
    return { name, columns, rows };
  });
}

function sqliteRows(db: DatabaseSync, table: Table): Row[] {
  if (
    table.optional &&
    !db
      .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
      .get(table.name)
  )
    return [];
  const fields = table.columns.filter((column) => column !== "ordinal");
  const hasAnnotations =
    table.name !== "documents" ||
    db
      .prepare("PRAGMA table_info(documents)")
      .all()
      .some((row) => row.name === "annotations");
  return db
    .prepare(
      `SELECT ${table.columns.includes("ordinal") ? "rowid AS ordinal," : ""}${fields.map((field) => (field === "annotations" && !hasAnnotations ? "'[]' AS annotations" : field)).join(",")} FROM ${table.name} ORDER BY ${table.columns.includes("ordinal") ? "rowid" : table.order}`,
    )
    .all()
    .map((row) => {
      const result: Row = {};
      for (const column of table.columns) {
        const value = row[column];
        result[column] = table.json?.includes(column)
          ? JSON.parse(String(value))
          : value;
      }
      return result;
    });
}

function mediaReferences(rows: Map<string, Row[]>, uploads: string) {
  const names = new Set<string>();
  let external = 0;
  function add(url: unknown) {
    if (typeof url !== "string" || !url) return;
    if (!url.startsWith("/media/")) {
      external++;
      return;
    }
    const name = decodeURIComponent(url.slice("/media/".length));
    if (!/^[a-zA-Z0-9-]+\.(?:jpg|png|webp|gif|pdf)$/.test(name))
      throw new Error("Некорректная ссылка на локальный медиафайл");
    names.add(name);
  }
  for (const row of rows.get("people") || []) add((row.data as Row)?.photo);
  for (const row of rows.get("photos") || []) add((row.data as Row)?.url);
  for (const row of rows.get("documents") || []) {
    add(`/media/${row.file_name}`);
    const file = join(uploads, String(row.file_name));
    if (existsSync(file) && statSync(file).size !== Number(row.file_size))
      throw new Error("Размер оригинала документа не совпал с записью SQLite");
  }
  const missing = [...names].filter((name) => !existsSync(join(uploads, name)));
  if (missing.length)
    throw new Error(`Не найдены оригиналы файлов: ${missing.length}`);
  return { local: names.size, external };
}

function fileSha256(path: string) {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const handle = openSync(path, "r");
  try {
    for (
      let read = readSync(handle, buffer, 0, buffer.length, null);
      read > 0;
      read = readSync(handle, buffer, 0, buffer.length, null)
    )
      digest.update(buffer.subarray(0, read));
  } finally {
    closeSync(handle);
  }
  return digest.digest("hex");
}

export function inspectSqliteSnapshot(sqlitePath: string, uploads: string) {
  if (basename(sqlitePath) === "drevo.sqlite")
    throw new Error(
      "Используйте согласованную копию SQLite, а не рабочий файл drevo.sqlite",
    );
  if (!statSync(sqlitePath).isFile()) throw new Error("Нужен файл SQLite");
  const db = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok")
      throw new Error("Копия SQLite не прошла integrity_check");
    const schemaVersion = Number(
      db.prepare("PRAGMA user_version").get()?.user_version,
    );
    if (schemaVersion !== ARCHIVE_SCHEMA_VERSION)
      throw new Error(
        `Ожидалась схема SQLite ${ARCHIVE_SCHEMA_VERSION}, получена ${schemaVersion}`,
      );
    db.exec("BEGIN");
    const archive = db
      .prepare("SELECT title,description,demo,revision FROM archive WHERE id=1")
      .get();
    if (!archive) throw new Error("В копии нет основного архива");
    const rows = new Map(
      tables.map((table) => [table.name, sqliteRows(db, table)]),
    );
    const services = sqliteServiceTables(db);
    const media = mediaReferences(rows, uploads);
    db.exec("ROLLBACK");
    return {
      archive,
      rows,
      services,
      media,
      schemaVersion,
      sha256: fileSha256(sqlitePath),
    };
  } finally {
    db.close();
  }
}

export async function importSqliteSnapshot(
  sqlitePath: string,
  uploads: string,
  archiveId: string,
  client: pg.Client,
  ownerUserId?: string,
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$/.test(archiveId))
    throw new Error("Некорректный archive_id");
  const snapshot = inspectSqliteSnapshot(sqlitePath, uploads);
  const schema = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "001_archive_core.sql"),
    "utf8",
  );
  const serviceSchema = readFileSync(
    join(
      fileURLToPath(new URL(".", import.meta.url)),
      "002_service_snapshot.sql",
    ),
    "utf8",
  );
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query("SELECT pg_advisory_xact_lock(24050260927)");
    await client.query(schema);
    await client.query(serviceSchema);
    if ((await client.query("SELECT 1 FROM archives LIMIT 1")).rowCount)
      throw new Error(
        "Целевая БД уже содержит архив; повторный импорт запрещён",
      );
    await client.query(
      "INSERT INTO archives(id,title,description,demo,revision,sqlite_schema_version) VALUES($1,$2,$3,$4,$5,$6)",
      [
        archiveId,
        snapshot.archive.title,
        snapshot.archive.description,
        Boolean(snapshot.archive.demo),
        snapshot.archive.revision,
        snapshot.schemaVersion,
      ],
    );
    const counts: Record<string, number> = {};
    for (const table of tables) {
      const rows = snapshot.rows.get(table.name)!;
      counts[table.name] = rows.length;
      const columns = ["archive_id", ...table.columns];
      const sql = `INSERT INTO ${table.name}(${columns.join(",")}) VALUES(${columns.map((_, index) => `$${index + 1}`).join(",")})`;
      for (const row of rows)
        await client.query(sql, [
          archiveId,
          ...table.columns.map((column) =>
            table.json?.includes(column)
              ? JSON.stringify(row[column])
              : row[column],
          ),
        ]);
      const actual = (
        await client.query(
          `SELECT ${table.columns.join(",")} FROM ${table.name} WHERE archive_id=$1 ORDER BY ${table.order}`,
          [archiveId],
        )
      ).rows.map((row: Row) => {
        for (const number of table.numbers || [])
          row[number] = Number(row[number]);
        return row;
      });
      if (!isDeepStrictEqual(actual, rows))
        throw new Error(
          `Данные таблицы ${table.name} не совпали после переноса`,
        );
    }
    for (const service of snapshot.services) {
      await client.query(
        "INSERT INTO service_snapshot_tables(archive_id,name,columns,row_count) VALUES($1,$2,$3,$4)",
        [
          archiveId,
          service.name,
          JSON.stringify(service.columns),
          service.rows.length,
        ],
      );
      for (const row of service.rows)
        await client.query(
          "INSERT INTO service_snapshot_rows(archive_id,table_name,ordinal,data) VALUES($1,$2,$3,$4)",
          [archiveId, service.name, row.ordinal, JSON.stringify(row.data)],
        );
      const actual = (
        await client.query(
          "SELECT ordinal,data FROM service_snapshot_rows WHERE archive_id=$1 AND table_name=$2 ORDER BY ordinal",
          [archiveId, service.name],
        )
      ).rows.map((row: { ordinal: string; data: Row }) => ({
        ordinal: Number(row.ordinal),
        data: row.data,
      }));
      if (!isDeepStrictEqual(actual, service.rows))
        throw new Error(
          `Данные служебной таблицы ${service.name} не совпали после переноса`,
        );
      counts[service.name] = service.rows.length;
    }
    const access = await backfillArchiveAccessInTransaction(
      client,
      archiveId,
      ownerUserId,
    );
    await client.query(
      readFileSync(
        join(
          fileURLToPath(new URL(".", import.meta.url)),
          "005_archive_owner_uniqueness.sql",
        ),
        "utf8",
      ),
    );
    await client.query(
      readFileSync(
        join(
          fileURLToPath(new URL(".", import.meta.url)),
          "006_oauth_transactions.sql",
        ),
        "utf8",
      ),
    );
    await client.query(
      readFileSync(
        join(
          fileURLToPath(new URL(".", import.meta.url)),
          "007_account_identities.sql",
        ),
        "utf8",
      ),
    );
    await client.query(
      "INSERT INTO account_identities(provider,subject,account_id) SELECT CASE WHEN id LIKE 'vk:%' THEN 'vk' ELSE 'yandex' END,CASE WHEN id LIKE 'vk:%' THEN substring(id FROM 4) ELSE id END,id FROM accounts",
    );
    await client.query(
      readFileSync(
        join(
          fileURLToPath(new URL(".", import.meta.url)),
          "008_account_tiers.sql",
        ),
        "utf8",
      ),
    );
    // The migration must not silently reduce existing participants to the
    // future registration tier.
    await client.query(
      "INSERT INTO account_tiers(account_id,full_access) SELECT id,true FROM accounts",
    );
    await client.query(
      readFileSync(
        new URL("./009_person_removals.sql", import.meta.url),
        "utf8",
      ),
    );
    const audit = await backfillArchiveAuditInTransaction(client, archiveId);
    const services = await backfillRuntimeServicesInTransaction(
      client,
      archiveId,
    );
    await client.query("COMMIT");
    return {
      archiveId,
      counts,
      access,
      audit,
      services,
      media: snapshot.media,
      sqliteSha256: snapshot.sha256,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [sqlitePath, uploads, archiveId, ownerUserId] = process.argv.slice(2);
  if (!sqlitePath || !uploads || !archiveId)
    throw new Error(
      "Использование: import-sqlite.ts <копия.sqlite> <uploads/> <archive_id> [owner_user_id]",
    );
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    console.log(
      JSON.stringify(
        await importSqliteSnapshot(
          sqlitePath,
          uploads,
          archiveId,
          client,
          ownerUserId,
        ),
      ),
    );
  } finally {
    await client.end();
  }
}
