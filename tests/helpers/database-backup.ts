import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { writeDatabaseBackup } from "../../src/server/backup.ts";

export function databaseBackupBytes(db: DatabaseSync) {
  const directory = mkdtempSync(join(tmpdir(), "drevo-backup-test-")),
    file = join(directory, "archive.sqlite");
  try {
    writeDatabaseBackup(db, file);
    return readFileSync(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
