import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { resolve } from "node:path";
import {
  backupManager,
  BackupBusyError,
} from "../src/server/backup-manager.ts";

const database = resolve(
  process.env.DATABASE_PATH || "/var/www/drevo.kiiko.ru/shared/drevo.sqlite",
);
const db = new DatabaseSync(database);
db.exec("PRAGMA busy_timeout=10000");
initializeArchiveSchema(db);
const backups = backupManager(db, database, { schedule: false });
try {
  if (process.argv.includes("--now")) backups.startCreate();
  else backups.tick();
  await backups.idle();
  const job = backups.status("system").job;
  if (job?.state === "failed") {
    console.error(job.error);
    process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof BackupBusyError)) throw error;
  console.log("Backup already running.");
} finally {
  await backups.close();
  db.close();
}
