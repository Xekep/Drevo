import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { StoreDatabase } from "../../src/server/store-database.ts";
import { writeDatabaseBackup } from "../../src/server/backup.ts";

export async function databaseBackupBytes(db: DatabaseSync | StoreDatabase) {
  const directory = mkdtempSync(join(tmpdir(), "drevo-backup-test-")),
    file = join(directory, "archive.sqlite");
  try {
    await writeDatabaseBackup(db, file);
    return readFileSync(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
