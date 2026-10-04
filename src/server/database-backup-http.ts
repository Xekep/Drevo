import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { writeDatabaseBackup } from "./backup.ts";
import { fullBackup } from "./full-backup.ts";
import { ForbiddenError } from "./users.ts";
import { isArchiveOwner } from "../domain/access.ts";

export function databaseBackupHttp({
  archive,
  auth,
  beforeSend,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  beforeSend?: () => Promise<void>;
}) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  const deliverPrepared = async (req: IncomingMessage, res: ServerResponse,
    actorId: string, file: string, full: boolean) => {
    const info = await stat(file);
    const first = Buffer.alloc(Math.min(1, info.size));
    if (first.length) {
      const handle = await open(file, "r");
      try { await handle.read(first, 0, first.length, 0); }
      finally { await handle.close(); }
    }
    const headers = {
      "Content-Type": full ? "application/gzip" : "application/vnd.sqlite3",
      "Content-Disposition": full
        ? `attachment; filename="drevo-full-${new Date().toISOString().slice(0, 10)}.tar.gz"`
        : `attachment; filename="drevo-${new Date().toISOString().slice(0, 10)}.sqlite"`,
      "Content-Length": String(info.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (!auth.local && archive.db.kind === "postgres" && archive.db.postgresTransaction) {
      const session = await auth.accountSession(req);
      if (!session || session.accountId !== actorId)
        return json(res, 401, { error: "Сессия завершена" });
      let outcome: "sent" | "session" | "access";
      try {
        outcome = await archive.db.postgresTransaction(async (client) => {
          const account = await client.query(
            "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [actorId]);
          if (!account.rowCount) return "access";
          const active = await client.query<{ expires_at: string }>(
            `SELECT expires_at FROM account_sessions
             WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [session.tokenHash, actorId]);
          if (!active.rows[0] || Number(active.rows[0].expires_at) <= Date.now())
            return "session";
          await client.query("SELECT set_config('drevo.account_id',$1,true)", [actorId]);
          const member = await client.query<{ approved: boolean }>(
            `SELECT approved FROM archive_memberships
             WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [archive.db.archiveId, actorId]);
          const owner = await client.query<{ user_id: string }>(
            "SELECT user_id FROM archive_owners WHERE archive_id=$1 FOR SHARE NOWAIT",
            [archive.db.archiveId]);
          const admin = await client.query(
            "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
            [actorId]);
          if (!member.rows[0]?.approved || owner.rows[0]?.user_id !== actorId ||
            !admin.rowCount) return "access";
          if (res.destroyed) return "sent";
          // A completed revoke before this byte denies the prepared backup.
          // After the first byte the download has started, so free all PG locks
          // before streaming a potentially large TAR over a slow connection.
          res.writeHead(200, headers);
          if (first.length) res.write(first);
          else res.end();
          return "sent";
        });
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(); return true; }
        if ((error as { code?: string }).code === "55P03")
          return json(res, 409, { error: "Доступ занят другим действием" });
        throw error;
      }
      if (outcome === "session") return json(res, 401, { error: "Сессия завершена" });
      if (outcome === "access") return json(res, 403, { error: "Доступ к архиву отозван" });
    } else {
      const current = await auth.currentUser(req);
      if (!current?.approved || !isArchiveOwner(current) || current.id !== actorId ||
        !(await auth.isPlatformAdmin(req)))
        return json(res, 403, { error: "Доступ к архиву отозван" });
      res.writeHead(200, headers);
      if (first.length) res.write(first);
      else res.end();
    }
    if (!first.length || res.destroyed) return true;
    try { await pipeline(createReadStream(file, { start: first.length }), res); }
    catch { if (!res.destroyed) res.destroy(); }
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
    const actor = await auth.currentUser(req);
    if (!actor?.approved || !isArchiveOwner(actor) || !(await auth.isPlatformAdmin(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: full
          ? "Системную копию может скачать администратор платформы"
          : "Копию базы может скачать администратор платформы",
      });

    if (full) {
      try {
        await fullBackup(archive.db, res, undefined, beforeSend,
          async (file) => { await deliverPrepared(req, res, actor.id, file, true); });
      } catch (error) {
        if (error instanceof ForbiddenError)
          return json(res, 403, { error: error.message });
        throw error;
      }
      return true;
    }

    const directory = await mkdtemp(join(tmpdir(), "drevo-download-")),
      file = join(directory, "drevo.sqlite");
    try {
      await writeDatabaseBackup(archive.db, file);
      await beforeSend?.();
      return await deliverPrepared(req, res, actor.id, file, false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
}
