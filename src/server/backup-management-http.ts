import { BackupInputError } from "./backup-store.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import {
  BackupBusyError,
  type BackupCoordinator,
} from "./backup-coordinator.ts";
import type { RestoreStore } from "./restore.ts";
import { isSameOriginRequest } from "./same-origin.ts";

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new BackupInputError("Запрос слишком большой.");
    chunks.push(Buffer.from(chunk));
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BackupInputError("Некорректный JSON.");
  }
}

export function backupManagementHttp({
  backups,
  restores,
  auth,
  publicOrigin,
}: {
  backups: BackupCoordinator;
  restores: RestoreStore;
  auth: ReturnType<typeof createAuth>;
  publicOrigin?: string;
}) {
  let downloading = false;
  const json = (res: ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
    return true;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const path = url.pathname;
    if (path !== "/api/backups" && !path.startsWith("/api/backups/"))
      return false;
    if (!auth.isAdmin(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "Резервные копии доступны только администратору.",
      });
    if (
      req.method !== "GET" &&
      (!isSameOriginRequest(req, publicOrigin) ||
        req.headers["x-drevo-backup"] !== "1")
    )
      return json(res, 403, { error: "Откройте резервные копии в админке." });
    try {
      if (path === "/api/backups" && req.method === "GET") {
        const offset = Number(url.searchParams.get("offset") || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
          throw new BackupInputError("Некорректная страница.");
        return json(
          res,
          200,
          backups.status(auth.currentUser(req)!.id, offset),
        );
      }
      if (path === "/api/backups/settings" && req.method === "PUT") {
        const body = await readJson(req);
        if (!auth.isAdmin(req))
          return json(res, 403, { error: "Доступ администратора отозван." });
        return json(res, 200, backups.save(body, auth.currentUser(req)!));
      }
      if (path === "/api/backups/check" && req.method === "POST") {
        const body = await readJson(req);
        if (!auth.isAdmin(req))
          return json(res, 403, { error: "Доступ администратора отозван." });
        return json(res, 202, backups.check(body, auth.currentUser(req)!));
      }
      if (path === "/api/backups/create" && req.method === "POST") {
        if (downloading)
          throw new BackupBusyError("Дождитесь скачивания резервной копии.");
        return json(res, 202, backups.startCreate(auth.currentUser(req)!));
      }
      const match = path.match(
        /^\/api\/backups\/([a-f0-9-]{36})\/(preview|download)$/,
      );
      if (match?.[2] === "preview" && req.method === "POST") {
        return json(
          res,
          202,
          backups.preview(
            match[1],
            auth.currentUser(req)!,
            async (file, signal) => {
              const assertAccess = () => {
                if (!auth.isAdmin(req))
                  throw new BackupInputError("Доступ администратора отозван.");
              };
              assertAccess();
              return restores.previewStream(
                createReadStream(file, { signal }),
                auth.currentUser(req)!,
                assertAccess,
              );
            },
          ),
        );
      }
      if (match?.[2] === "download" && req.method === "GET") {
        if (
          downloading ||
          backups.status(auth.currentUser(req)!.id).job?.state === "running"
        )
          throw new BackupBusyError(
            "Дождитесь завершения операции с резервными копиями.",
          );
        downloading = true;
        try {
          await backups.withFile(match[1], async (file, item) => {
            if (!auth.isAdmin(req))
              throw new BackupInputError("Доступ администратора отозван.");
            res.writeHead(200, {
              "Content-Type": "application/gzip",
              "Content-Length": String(item.size),
              "Content-Disposition": 'attachment; filename="' + item.name + '"',
              "Cache-Control": "no-store",
              "X-Content-Type-Options": "nosniff",
            });
            await pipeline(createReadStream(file), res);
          });
        } finally {
          downloading = false;
        }
        return true;
      }
      return json(res, 404, { error: "Операция не найдена." });
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return true;
      }
      if (error instanceof BackupInputError || error instanceof BackupBusyError)
        return json(res, error instanceof BackupBusyError ? 409 : 400, {
          error: error.message,
        });
      throw error;
    }
  };
}
