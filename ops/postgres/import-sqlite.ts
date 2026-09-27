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

type Row = Record<string, unknown>;
type Table = {
  name: string;
  columns: string[];
  order: string;
  json?: string[];
  numbers?: string[];
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
];

function sqliteRows(db: DatabaseSync, table: Table): Row[] {
  const fields = table.columns.filter((column) => column !== "ordinal");
  return db
    .prepare(
      `SELECT ${table.columns.includes("ordinal") ? "rowid AS ordinal," : ""}${fields.join(",")} FROM ${table.name} ORDER BY ${table.columns.includes("ordinal") ? "rowid" : table.order}`,
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
    const media = mediaReferences(rows, uploads);
    db.exec("ROLLBACK");
    return {
      archive,
      rows,
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
) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{2,63}$/.test(archiveId))
    throw new Error("Некорректный archive_id");
  const snapshot = inspectSqliteSnapshot(sqlitePath, uploads);
  const schema = readFileSync(
    join(fileURLToPath(new URL(".", import.meta.url)), "001_archive_core.sql"),
    "utf8",
  );
  await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
  try {
    await client.query("SELECT pg_advisory_xact_lock(24050260927)");
    await client.query(schema);
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
    await client.query("COMMIT");
    return {
      archiveId,
      counts,
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
  const [sqlitePath, uploads, archiveId] = process.argv.slice(2);
  if (!sqlitePath || !uploads || !archiveId)
    throw new Error(
      "Использование: import-sqlite.ts <копия.sqlite> <uploads/> <archive_id>",
    );
  const client = new pg.Client({ connectionTimeoutMillis: 5000 });
  try {
    await client.connect();
    console.log(
      JSON.stringify(
        await importSqliteSnapshot(sqlitePath, uploads, archiveId, client),
      ),
    );
  } finally {
    await client.end();
  }
}
