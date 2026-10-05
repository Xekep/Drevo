import { platformBackupSnapshot } from "./platform-backup-snapshot.ts";
const [database, primaryId, stage] = process.argv.slice(2);
if (!database || !stage) throw new Error("Missing platform backup paths");
// Never forward runtime archive context or its password to the native operator.
delete process.env.PGOPTIONS;
if (process.env.DATABASE_BACKEND === "postgres") {
  process.env.PGUSER = process.env.PLATFORM_BACKUP_PGUSER;
  if (process.env.PLATFORM_BACKUP_PGHOST) process.env.PGHOST = process.env.PLATFORM_BACKUP_PGHOST;
  if (process.env.PLATFORM_BACKUP_PGPORT) process.env.PGPORT = process.env.PLATFORM_BACKUP_PGPORT;
  if (process.env.PLATFORM_BACKUP_PGPASSWORD) process.env.PGPASSWORD = process.env.PLATFORM_BACKUP_PGPASSWORD;
  else delete process.env.PGPASSWORD;
}
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 25 * 60_000);
try { await platformBackupSnapshot(database, primaryId, stage, controller.signal); }
finally { clearTimeout(timer); }
