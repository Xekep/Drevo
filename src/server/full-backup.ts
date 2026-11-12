import { mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import type { StoreDatabase } from "./store-database.ts";
import { writeDatabaseBackup, writeTreeBackupSnapshot } from "./backup.ts";
import { stageTreeBackupFiles } from "./tree-backup-files.ts";
import { backupProcess } from "./backup-process.ts";

function databasePath(db: StoreDatabase) {
  const path = db.file;
  if (!path) throw new Error("Полный бэкап доступен только для файловой базы");
  return path;
}

/** The caller owns the staging directory until the prepared file is consumed. */
export async function prepareFullBackup(
  db: StoreDatabase,
  dbPath: string,
  directory: string,
  treeOnly: boolean,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (treeOnly) await writeTreeBackupSnapshot(db, join(directory, "drevo.sqlite"), signal);
  else await writeDatabaseBackup(db, join(directory, "drevo.sqlite"));
  signal.throwIfAborted();
  if (treeOnly)
    await stageTreeBackupFiles(join(directory, "drevo.sqlite"), dirname(dbPath), join(directory, "uploads"), signal);
  const destination = join(directory, "drevo.tar.gz");
  await backupProcess("tar", [
    "--exclude=uploads/.*", "-czf", destination,
    "-C", directory, "drevo.sqlite", "-C", treeOnly ? directory : dirname(dbPath), "uploads",
  ], signal);
  signal.throwIfAborted();
  return destination;
}

export async function fullBackup(
  db: StoreDatabase,
  pathOrResponse: string | ServerResponse,
  legacyResponse?: ServerResponse,
  beforeSend?: () => Promise<void>,
  deliverPrepared?: (path: string, res: ServerResponse) => Promise<void>,
  treeOnly = false,
  signal = AbortSignal.timeout(30 * 60_000),
) {
  const dbPath =
      typeof pathOrResponse === "string" ? pathOrResponse : databasePath(db),
    res = typeof pathOrResponse === "string" ? legacyResponse! : pathOrResponse;
  const directory = await mkdtemp(join(tmpdir(), "drevo-full-"));
  try {
    const destination = await prepareFullBackup(db, dbPath, directory, treeOnly, signal);
    await beforeSend?.();
    signal.throwIfAborted();
    if (deliverPrepared) {
      await deliverPrepared(destination, res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="drevo-full-${new Date().toISOString().slice(0, 10)}.tar.gz"`,
      "Cache-Control": "no-store",
    });
    await pipeline(createReadStream(destination), res, { signal });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
