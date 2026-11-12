import { memberPreviewTarget } from "./member-preview-access.ts";
import { lockBackupStaff } from "./tree-backup-access.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { writeTreeBackupSnapshot } from "./backup.ts";
import { prepareFullBackup } from "./full-backup.ts";
import { ForbiddenError } from "./users.ts";
import { canManageTreeBackups } from "../domain/access.ts";
import { backupCoordinator, BackupBusyError, BackupAccessError, type BackupCoordinator } from "./backup-coordinator.ts";
import { preparationAdmission, preparationRequest, PREPARATION_BYTES, type PreparationAdmission } from "./preparation-admission.ts";
import { WorkQueueBusyError } from "./work-queue.ts";

export function databaseBackupHttp({
  archive,
  auth,
  beforeSend,
  backups,
  preparation,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  beforeSend?: () => Promise<void>;
  backups?: BackupCoordinator;
  preparation?: PreparationAdmission;
}) {
  const budget = preparation ?? preparationAdmission();
  let fallback: Promise<BackupCoordinator> | undefined;
  const json = (res: ServerResponse, status: number, value: unknown) => {
    if (res.destroyed) return true;
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  const deliverPrepared = async (req: IncomingMessage, res: ServerResponse,
    actorId: string, file: string, full: boolean, signal: AbortSignal) => {
    signal.throwIfAborted();
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
    signal.throwIfAborted();
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
          const admin = await lockBackupStaff(client, actorId);
          if (!member.rows[0]?.approved || owner.rows[0]?.user_id !== actorId ||
            !admin) return "access";
          signal.throwIfAborted();
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
      if (!canManageTreeBackups(current) || current.id !== actorId || !!memberPreviewTarget(req))
        return json(res, 403, { error: "Доступ к архиву отозван" });
      signal.throwIfAborted();
      res.writeHead(200, headers);
      if (first.length) res.write(first);
      else res.end();
    }
    if (!first.length || res.destroyed) return true;
    try { await pipeline(createReadStream(file, { start: first.length }), res, { signal }); }
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
    if (!canManageTreeBackups(actor) || !!memberPreviewTarget(req))
      return json(res, actor ? 403 : 401, {
        error: "Копии древа доступны его владельцу с ролью администратора или исследователя платформы",
      });

    try {
      const session = auth.local ? null : await auth.accountSession(req);
      if (!auth.local && archive.db.kind === "postgres" && !session)
        return json(res, 401, { error: "Сессия завершена" });
      const coordinator = backups ?? await (fallback ??= backupCoordinator(archive.db,
        archive.db.file!, { treeOnly: true, schedule: false }));
      const request = preparationRequest(req, res, 30 * 60_000);
      let directory = "", release: (() => void) | undefined;
      const cleanup = async () => {
        try {
          if (directory) await rm(directory, { recursive: true, force: true });
          directory = "";
        } finally { release?.(); release = undefined; }
      };
      try {
        const file = await coordinator.download(actor, request.signal, async signal => {
          try {
            release = await budget.acquire(PREPARATION_BYTES.export, signal);
            directory = await mkdtemp(join(tmpdir(), full ? "drevo-full-" : "drevo-download-"));
            if (full) return await prepareFullBackup(archive.db, archive.db.file!, directory, true, signal);
            const file = join(directory, "drevo.sqlite");
            await writeTreeBackupSnapshot(archive.db, file, signal);
            return file;
          } catch (error) { await cleanup(); throw error; }
        }, session ? { accountId: session.accountId, tokenHash: session.tokenHash } : undefined);
        await beforeSend?.();
        request.signal.throwIfAborted();
        return await deliverPrepared(req, res, actor.id, file, full, request.signal);
      } finally {
        try { await cleanup(); }
        finally { request.dispose(); }
      }
    } catch (error) {
      if (res.destroyed) return true;
      if (error instanceof WorkQueueBusyError) {
        res.setHeader("Retry-After", "2");
        return json(res, 503, { error: "Подготовка копий занята. Повторите позже." });
      }
      if ((error as { code?: string }).code === "55P03")
        return json(res, 409, { error: "Доступ занят другим действием" });
      if (error instanceof BackupBusyError) {
        res.setHeader("Retry-After", "2");
        return json(res, 409, { error: error.message });
      }
      if (error instanceof BackupAccessError) return json(res, error.status, { error: error.message });
      if (error instanceof ForbiddenError) return json(res, 403, { error: error.message });
      throw error;
    }
  };
}
