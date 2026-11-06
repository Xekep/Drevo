import { DatabaseSync } from "node:sqlite";
import { statfs } from "node:fs/promises";
import { dirname } from "node:path";
import { initializeArchiveSchema } from "./schema.ts";
import type { StoreDatabase } from "./store-database.ts";
import { portableIdentifier as identifier, portableSnapshotSchema, portableSnapshotValue } from "./portable-snapshot-schema.ts";

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
    const schema = portableSnapshotSchema(target);
    target.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE");
    let committed = false;
    try {
      // Replay persisted metadata, not fresh changes. Message insert triggers
      // would require the chat before its rows and would alter saved versions
      // and timestamps. The target is isolated; restore its triggers atomically.
      const cursorTriggers = target
        .prepare(
          `SELECT name,sql FROM sqlite_schema
        WHERE type='trigger' AND name IN ('ai_message_insert_cursor',
          'ai_message_update_cursor','ai_proposal_status_cursor')`,
        )
        .all();
      for (const trigger of cursorTriggers)
        target.exec(`DROP TRIGGER ${identifier(String(trigger.name))}`);
      for (const table of schema)
        target.exec(`DELETE FROM ${identifier(table.name)}`);
      await source.transaction(async () => {
        for (const table of schema) {
          if (!table.select) continue;
          const names = table.columns.map(column => identifier(column.name)).join(",");
          const insert = target.prepare(
            `INSERT INTO ${identifier(table.name)}(${names}) VALUES(${table.columns.map(() => "?").join(",")})`,
          );
          await source.exec(
            "",
            `DECLARE portable_backup_rows NO SCROLL CURSOR FOR ${table.select}`,
          );
          try {
            for (;;) {
              const disk = await statfs(dirname(file));
              if (disk.bavail * disk.bsize < 256 * 1024 ** 2)
                throw new Error(
                  "Недостаточно места для переносимой копии. Запись остановлена до заполнения диска",
                );
              const rows = await source
                .prepare("", "FETCH FORWARD 500 FROM portable_backup_rows")
                .all();
              if (!rows.length) break;
              for (const row of rows)
                insert.run(
                  ...table.columns.map(column => portableSnapshotValue(table.name, column, row[column.name])),
                );
            }
          } finally {
            await source.exec("", "CLOSE portable_backup_rows");
          }
        }
      }, true);
      for (const trigger of cursorTriggers) target.exec(String(trigger.sql));
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
