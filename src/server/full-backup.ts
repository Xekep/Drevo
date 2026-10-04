import { mkdtemp, rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import type { StoreDatabase } from "./store-database.ts";
import { writeDatabaseBackup } from "./backup.ts";

function databasePath(db: StoreDatabase) {
  const path = db.file;
  if (!path) throw new Error("Полный бэкап доступен только для файловой базы");
  return path;
}

export async function fullBackup(
  db: StoreDatabase,
  pathOrResponse: string | ServerResponse,
  legacyResponse?: ServerResponse,
  beforeSend?: () => Promise<void>,
  deliverPrepared?: (path: string, res: ServerResponse) => Promise<void>,
) {
  const dbPath =
      typeof pathOrResponse === "string" ? pathOrResponse : databasePath(db),
    res = typeof pathOrResponse === "string" ? legacyResponse! : pathOrResponse;
  const directory = await mkdtemp(join(tmpdir(), "drevo-full-"));
  try {
    await writeDatabaseBackup(db, join(directory, "drevo.sqlite"));
    const destination = join(directory, "drevo.tar.gz");
    await new Promise<void>((done, reject) => {
      const process = spawn(
        "tar",
        [
          "--exclude=uploads/.*",
          "-czf",
          destination,
          "-C",
          directory,
          "drevo.sqlite",
          "-C",
          dirname(dbPath),
          "uploads",
        ],
        { windowsHide: true, stdio: "ignore" },
      );
      process.once("error", reject);
      process.once("close", (code) =>
        code === 0
          ? done()
          : reject(new Error("Не удалось собрать архив фотографий")),
      );
    });
    await beforeSend?.();
    if (deliverPrepared) {
      await deliverPrepared(destination, res);
      return;
    }
    res.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": `attachment; filename="drevo-full-${new Date().toISOString().slice(0, 10)}.tar.gz"`,
      "Cache-Control": "no-store",
    });
    await pipeline(createReadStream(destination), res);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
