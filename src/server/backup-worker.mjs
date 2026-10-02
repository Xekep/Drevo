// Isolate snapshot creation and validation from the HTTP event loop.
import { DatabaseSync } from "node:sqlite";
import { writeDatabaseBackup } from "./backup.ts";
import {
  storeDatabase,
  openPostgresDatabase,
  configuredDatabaseBackend,
} from "./store-database.ts";
const [source, destination, archiveId] = process.argv.slice(2);
if (!source || !destination) throw new Error("Missing backup paths");
const db =
  configuredDatabaseBackend(source) === "postgres"
    ? await openPostgresDatabase(archiveId || "", source)
    : storeDatabase(new DatabaseSync(source, { readOnly: true }));
try {
  await writeDatabaseBackup(db, destination);
} finally {
  await db.close();
}
const copy = new DatabaseSync(destination, { readOnly: true });
try {
  if (
    copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
    copy.prepare("PRAGMA foreign_key_check").all().length
  )
    throw new Error("Backup database failed integrity validation");
} finally {
  copy.close();
}
