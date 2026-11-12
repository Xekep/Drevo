import type { DatabaseSync } from "node:sqlite";
import { storeDatabase, type StoreDatabase } from "./store-database.ts";
import { writePortablePostgresBackup } from "./postgres-portable-backup.ts";
import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { backupProcess } from "./backup-process.ts";

/** Keep portable export, sanitization and validation outside the HTTP event loop. */
export async function writeTreeBackupSnapshot(db: StoreDatabase, file: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!db.file || db.file === ":memory:") throw new Error("Копия доступна только для файловой базы");
  await backupProcess(process.execPath, [
    "--experimental-strip-types",
    fileURLToPath(new URL("./backup-worker.mjs", import.meta.url)),
    db.file, file, db.archiveId || "", "tree",
  ], signal, undefined, { workerDiagnostics: true });
}

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
