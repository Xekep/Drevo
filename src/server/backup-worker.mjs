// Isolate snapshot creation and validation from the HTTP event loop.
import { DatabaseSync } from "node:sqlite";
import { writeDatabaseBackup } from "./backup.ts";
import { sanitizeTreeBackup } from "./tree-backup-files.ts";
import { backupWorkerFailure } from "./backup-worker-failure.ts";
import {
  storeDatabase,
  openPostgresDatabase,
  configuredDatabaseBackend,
} from "./store-database.ts";
const [source, destination, archiveId, scope] = process.argv.slice(2);
let stage = "open";
async function run() {
  if (!source || !destination) throw new Error("Missing backup paths");
  const db = configuredDatabaseBackend(source) === "postgres"
    ? await openPostgresDatabase(archiveId || "", source)
    : storeDatabase(new DatabaseSync(source, { readOnly: true }));
  try {
    stage = "snapshot";
    await writeDatabaseBackup(db, destination);
    if (scope === "tree") {
      stage = "sanitize";
      sanitizeTreeBackup(destination);
    }
  } finally { await db.close(); }
  stage = "validate";
  const copy = new DatabaseSync(destination, { readOnly: true });
  try {
    if (copy.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      copy.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Backup database failed integrity validation");
  } finally { copy.close(); }
}
await run().catch(async error => {
  const failure = backupWorkerFailure(error, stage);
  process.exitCode = 1;
  if (process.send) {
    await new Promise(resolve => process.send(failure, () => resolve()));
    if (process.connected) process.disconnect();
  } else console.error(JSON.stringify(failure));
});
