import type { DatabaseSync } from "node:sqlite";
import { storeDatabase, type StoreDatabase } from "./store-database.ts";
import { writePortablePostgresBackup } from "./postgres-portable-backup.ts";
import { chmodSync, existsSync, unlinkSync } from "node:fs";

/** VACUUM INTO includes committed WAL changes and produces a standalone SQLite file. */
export async function writeDatabaseBackup(
  source: DatabaseSync | StoreDatabase,
  file: string,
) {
  const db = storeDatabase(source);
  const existed = existsSync(file);
  try {
    if (existed) throw new Error("Файл резервной копии уже существует");
    if (db.kind === "postgres") await writePortablePostgresBackup(db, file);
    else await db.prepare("VACUUM INTO ?").run(file);
    chmodSync(file, 0o600);
  } catch (error) {
    if (!existed)
      try {
        unlinkSync(file);
      } catch {
        /* VACUUM or chmod may fail before a file exists. */
      }
    throw error;
  }
}
