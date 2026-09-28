import { DatabaseSync } from "node:sqlite";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import {
  openPostgresDatabase,
  configuredDatabaseBackend,
  storeDatabase,
} from "../src/server/store-database.ts";
import { resolve } from "node:path";
import {
  backupCoordinator,
  BackupBusyError,
} from "../src/server/backup-coordinator.ts";

const database = resolve(
  process.env.DATABASE_PATH || "/var/www/drevo.kiiko.ru/shared/drevo.sqlite",
);
const db =
  configuredDatabaseBackend(database) === "postgres"
    ? await openPostgresDatabase(process.env.ARCHIVE_ID || "", database)
    : (() => {
        const sqlite = new DatabaseSync(database);
        sqlite.exec("PRAGMA busy_timeout=10000");
        initializeArchiveSchema(sqlite);
        return storeDatabase(sqlite);
      })();
const backups = await backupCoordinator(db, database, { schedule: false });
try {
  if (process.argv.includes("--now")) await backups.startCreate();
  else await backups.tick();
  await backups.idle();
  const job = (await backups.status("system")).job;
  if (job?.state === "failed") {
    console.error(job.error);
    process.exitCode = 1;
  }
} catch (error) {
  if (!(error instanceof BackupBusyError)) throw error;
  console.log("Backup already running.");
} finally {
  await backups.close();
  await db.close();
}
