import type { DatabaseSync } from "node:sqlite";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  unlinkSync,
  rmdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/** Возвращает backup в памяти для HTTP-ответов и других byte-oriented вызовов. */
export function databaseBackup(db: DatabaseSync) {
  const directory = mkdtempSync(join(tmpdir(), "drevo-backup-")),
    file = join(directory, "archive.sqlite");
  try {
    writeDatabaseBackup(db, file);
    return readFileSync(file);
  } finally {
    try {
      unlinkSync(file);
    } catch {
      /* A failed VACUUM may not create a file. */
    }
    rmdirSync(directory);
  }
}
