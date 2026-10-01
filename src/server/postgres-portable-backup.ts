import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "./schema.ts";
import type { StoreDatabase } from "./store-database.ts";

/** Portable archive backup, not a second live database. Native PostgreSQL/WAL
 * backups remain the disaster-recovery source. This format keeps existing
 * downloadable backups and the archive restore preview backwards compatible.
 */
export async function writePortablePostgresBackup(
  source: StoreDatabase,
  file: string,
) {
  const target = new DatabaseSync(file);
  try {
    initializeArchiveSchema(target);
    const tables = target
      .prepare(
        "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all()
      .map((row) => String(row.name));
    const identifier = (value: string) => {
      if (!/^[a-z_]+$/.test(value))
        throw new Error("Неизвестный столбец резервной копии");
      return `"${value}"`;
    };
    const projections: Record<string, string> = {
      archive:
        "SELECT 1 AS id,title,description,demo::integer AS demo,revision FROM archives",
      users: "SELECT * FROM runtime_users",
      auth_sessions:
        "SELECT s.* FROM account_sessions s WHERE EXISTS (SELECT 1 FROM runtime_users u WHERE u.id=s.user_id)",
      access_settings: "SELECT * FROM runtime_access_settings",
      tree_settings: "SELECT * FROM runtime_tree_settings",
      audit_entries: "SELECT * FROM archive_audit_entries",
      audit_people: "SELECT * FROM archive_audit_people",
      person_comments:
        "SELECT archive_id,id,person_id,author_id,author_name,created_ms,text,updated_ms,attachments::text AS attachments FROM person_comments",
      source_catalog:
        "SELECT archive_id,id,data::text AS data,version FROM source_catalog",
    };
    const ordered = new Set([
      "people",
      "relations",
      "photos",
      "photo_tags",
      "documents",
      "document_people",
      "share_links",
      "face_descriptors",
    ]);
    target.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    let committed = false;
    try {
      for (const table of tables)
        target.exec(`DELETE FROM ${identifier(table)}`);
      await source.transaction(async () => {
        for (const table of tables) {
          const columns = target
            .prepare(`PRAGMA table_info(${identifier(table)})`)
            .all()
            .map((row) => String(row.name));
          const names = columns.map(identifier).join(",");
          const projection =
            projections[table] || `SELECT * FROM ${identifier(table)}`;
          const select = `SELECT ${names} FROM (${projection}${ordered.has(table) ? " ORDER BY ordinal" : ""}) AS saved`;
          const insert = target.prepare(
            `INSERT INTO ${identifier(table)}(${names}) VALUES(${columns.map(() => "?").join(",")})`,
          );
          await source.exec(
            "",
            `DECLARE portable_backup_rows NO SCROLL CURSOR FOR ${select}`,
          );
          try {
            for (;;) {
              const rows = await source
                .prepare("", "FETCH FORWARD 500 FROM portable_backup_rows")
                .all();
              if (!rows.length) break;
              for (const row of rows)
                insert.run(
                  ...columns.map((column) => {
                    const value = row[column];
                    if (
                      value === null ||
                      typeof value === "string" ||
                      typeof value === "number" ||
                      typeof value === "bigint"
                    )
                      return value;
                    throw new Error(
                      `Некорректное поле копии: ${table}.${column}`,
                    );
                  }),
                );
            }
          } finally {
            await source.exec("", "CLOSE portable_backup_rows");
          }
        }
      }, true);
      if (target.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Резервная копия содержит нарушенные ссылки");
      target.exec("COMMIT");
      committed = true;
      if (
        target.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
      )
        throw new Error("Резервная копия не прошла проверку целостности");
      target.exec(
        "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE",
      );
    } catch (error) {
      if (!committed) target.exec("ROLLBACK");
      throw error;
    }
  } finally {
    target.close();
  }
}
