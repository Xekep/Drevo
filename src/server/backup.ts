import type { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  unlinkSync,
} from "node:fs";

/** VACUUM INTO includes committed WAL changes and produces a standalone SQLite file. */
export function writeDatabaseBackup(db: DatabaseSync, file: string) {
  const existed = existsSync(file);
  try {
    db.prepare("VACUUM INTO ?").run(file);
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
