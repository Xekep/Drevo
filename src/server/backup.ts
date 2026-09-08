import type { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, unlinkSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
/** VACUUM INTO includes committed WAL changes and produces a standalone SQLite file. */
export function databaseBackup(db: DatabaseSync) {
  const directory = mkdtempSync(join(tmpdir(), "drevo-backup-")),
    file = join(directory, "archive.sqlite");
  try {
    db.prepare("VACUUM INTO ?").run(file);
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
