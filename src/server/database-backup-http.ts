import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { writeDatabaseBackup } from "./backup.ts";
import { fullBackup } from "./full-backup.ts";

export function databaseBackupHttp({
  archive,
  auth,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
}) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const full = url.pathname === "/api/backup/full";
    if ((!full && url.pathname !== "/api/backup") || req.method !== "GET")
      return false;
    if (!auth.isAdmin(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: full
          ? "Only administrators can download backups"
          : "Only administrators can download database backups",
      });

    if (full) {
      await fullBackup(archive.db, res);
      return true;
    }

    const directory = await mkdtemp(join(tmpdir(), "drevo-download-")),
      file = join(directory, "drevo.sqlite");
    try {
      writeDatabaseBackup(archive.db, file);
      const info = await stat(file);
      res.writeHead(200, {
        "Content-Type": "application/vnd.sqlite3",
        "Content-Disposition": `attachment; filename="drevo-${new Date().toISOString().slice(0, 10)}.sqlite"`,
        "Content-Length": String(info.size),
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      try {
        await pipeline(createReadStream(file), res);
      } catch {
        if (!res.destroyed) res.destroy();
      }
      return true;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
