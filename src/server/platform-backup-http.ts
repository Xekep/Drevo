import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { finished, pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import type { PlatformBackupCoordinator } from "./platform-backup-coordinator.ts";
import { PlatformBackupUnavailable } from "./platform-backup-coordinator.ts";
import { BackupBusyError } from "./backup-coordinator.ts";
import { BackupInputError } from "./backup-store.ts";
import { assertCurrentPlatformAdmin, PlatformAccessBusy, PlatformAccessDenied } from "./platform-access.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { memberPreviewTarget } from "./member-preview-access.ts";

export function platformBackupHttp({ backups, auth, db, publicOrigin }: {
  backups: PlatformBackupCoordinator; auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase; publicOrigin?: string;
}) {
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    res.end(JSON.stringify(data)); return true;
  };
  async function locked<T>(req: IncomingMessage, work: () => Promise<T>) {
    if (memberPreviewTarget(req)) throw new PlatformAccessDenied("В режиме участника копии недоступны");
    if (!auth.local && db.kind === "postgres" && db.postgresTransaction) {
      const session = await auth.accountSession(req);
      if (!session) throw new PlatformAccessDenied("Сеанс завершён");
      return db.postgresTransaction(async (client) => {
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        return work();
      });
    }
    if (!await auth.isPlatformAdmin(req)) throw new PlatformAccessDenied("Нужны права администратора платформы");
    return work();
  }
  async function send(req: IncomingMessage, res: ServerResponse, status: number, data: unknown) {
    return locked(req, async () => {
      const complete = finished(res, { cleanup: true }).catch(() => {});
      const timer = setTimeout(() => res.destroy(), 5000); timer.unref();
      try { json(res, status, data); await complete; }
      finally { clearTimeout(timer); }
      return true;
    });
  }
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const path = url.pathname;
    if (path !== "/api/platform/backups" && !path.startsWith("/api/platform/backups/")) return false;
    if (memberPreviewTarget(req) || !await auth.isPlatformAdmin(req))
      return json(res, await auth.accountId(req) ? 403 : 401, { error: "Копии платформы доступны только её администратору." });
    if (req.method !== "GET" && (!isSameOriginRequest(req, publicOrigin) || req.headers["x-drevo-backup"] !== "1"))
      return json(res, 403, { error: "Откройте резервные копии в админке платформы." });
    try {
      if ((path === "/api/platform/backups" || path === "/api/platform/backups/") && req.method === "GET") {
        const offset = Number(url.searchParams.get("offset") || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new BackupInputError("Некорректная страница");
        return send(req, res, 200, await backups.status(undefined, offset));
      }
      if (path === "/api/platform/backups/create" && req.method === "POST") {
        const job = await locked(req, () => backups.startCreate());
        return send(req, res, 202, job);
      }
      if ((path.endsWith("/settings") && req.method === "PUT") || (path.endsWith("/check") && req.method === "POST")) {
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length; if (size > 4096) throw new BackupInputError("Запрос слишком большой");
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const result = await locked<unknown>(req, () => path.endsWith("/settings") ? backups.save(body) : backups.check(body));
        return send(req, res, path.endsWith("/settings") ? 200 : 202, result);
      }
      const download = /^\/api\/platform\/backups\/([a-f0-9-]{36})\/download$/.exec(path);
      if (download && req.method === "GET") {
        await backups.withFile(download[1], async (file, item) => {
          const handle = await open(file, "r");
          try {
            const first = Buffer.alloc(Math.min(item.size, 64 * 1024));
            const { bytesRead } = await handle.read(first, 0, first.length, 0);
            await locked(req, async () => {
              if (res.destroyed) return;
              res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": String(item.size),
                "Content-Disposition": 'attachment; filename="' + item.name + '"',
                "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
              if (bytesRead) res.write(first.subarray(0, bytesRead)); else res.end();
            });
            if (res.destroyed || !bytesRead) return;
            const timer = setTimeout(() => res.destroy(), 2 * 60 * 60_000); timer.unref();
            res.setTimeout(60_000, () => res.destroy());
            try { await pipeline(createReadStream(file, { fd: handle.fd, autoClose: false, start: bytesRead }), res); }
            finally { clearTimeout(timer); }
          } finally { await handle.close(); }
        });
        return true;
      }
      return json(res, 404, { error: "Операция с копией платформы не найдена. Полное восстановление выполняется в режиме обслуживания." });
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return true; }
      const known = error instanceof BackupInputError || error instanceof BackupBusyError ||
        error instanceof PlatformAccessDenied || error instanceof PlatformAccessBusy || error instanceof PlatformBackupUnavailable;
      if (!known) console.error(JSON.stringify({ event: "platform_backup_http_failed",
        name: error instanceof Error ? error.name : undefined, code: (error as { code?: string }).code }));
      return json(res, error instanceof PlatformBackupUnavailable ? 503 : error instanceof PlatformAccessDenied ? 403 :
        error instanceof PlatformAccessBusy || error instanceof BackupBusyError ? 409 : known || error instanceof SyntaxError ? 400 : 500,
        { error: known && error instanceof Error ? error.message : "Не удалось выполнить операцию с копией платформы." });
    }
  };
}
