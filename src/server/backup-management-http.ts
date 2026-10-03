import { BackupInputError, validateBackupSettings } from "./backup-store.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { finished, pipeline } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import {
  BackupAccessError,
  BackupBusyError,
  type BackupCoordinator,
} from "./backup-coordinator.ts";
import type { RestoreStore } from "./restore.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import type { StoreDatabase } from "./store-database.ts";

const firstChunkBytes = 64 * 1024;
const downloadIdleTimeoutMs = 60_000;
const downloadMaxTimeMs = 2 * 60 * 60_000;

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new BackupInputError("Запрос слишком большой.");
    chunks.push(Buffer.from(chunk));
  }
  if (!size) return {};
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
  db,
  publicOrigin,
  beforeDelivery,
  beforeLockedDelivery,
}: {
  backups: BackupCoordinator;
  restores: RestoreStore;
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  publicOrigin?: string;
  beforeDelivery?: () => Promise<void>;
  beforeLockedDelivery?: () => Promise<void>;
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
    if (!(await auth.isPlatformAdmin(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: "Системные резервные копии доступны администратору платформы.",
      });
    if (
      req.method !== "GET" &&
      (!isSameOriginRequest(req, publicOrigin) ||
        req.headers["x-drevo-backup"] !== "1")
    )
      return json(res, 403, { error: "Откройте резервные копии в админке." });
    try {
      if ((path === "/api/backups" || path === "/api/backups/") && req.method === "GET") {
        const offset = Number(url.searchParams.get("offset") || 0);
        if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
          throw new BackupInputError("Некорректная страница.");
        const status = await backups.status((await auth.currentUser(req))!.id, offset);
        if (!auth.local && db.kind === "postgres" && db.postgresTransaction) {
          const session = await auth.accountSession(req);
          if (!session)
            return json(res, 401, { error: "Доступ администратора отозван." });
          return await db.postgresTransaction(async (client) => {
            // Account deletion locks account before session; use the same order.
            const account = await client.query(
              "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [session.accountId]);
            if (!account.rowCount)
              return json(res, 401, { error: "Доступ администратора отозван." });
            const active = await client.query<{ expires_at: string }>(
              `SELECT expires_at FROM account_sessions
               WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [session.tokenHash, session.accountId]);
            if (!active.rows[0] || Number(active.rows[0].expires_at) <= Date.now())
              return json(res, 401, { error: "Доступ администратора отозван." });
            await client.query("SELECT set_config('drevo.account_id',$1,true)",
              [session.accountId]);
            const membership = await client.query<{ approved: boolean }>(
              `SELECT approved FROM archive_memberships
               WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [db.archiveId, session.accountId]);
            const platformGrant = await client.query(
              "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
              [session.accountId]);
            if (!membership.rows[0]?.approved || !platformGrant.rowCount)
              return json(res, 403, { error: "Доступ администратора отозван." });
            return json(res, 200, status);
          });
        }
        if (!(await auth.isPlatformAdmin(req)))
          return json(res, (await auth.currentUser(req)) ? 403 : 401,
            { error: "Доступ администратора отозван." });
        return json(res, 200, status);
      }
      if (path === "/api/backups/settings" && req.method === "PUT") {
        const body = await readJson(req);
        if (!(await auth.isPlatformAdmin(req)))
          return json(res, 403, { error: "Доступ администратора отозван." });
        if (!auth.local && db.kind === "postgres" && db.postgresTransaction) {
          const checked = validateBackupSettings(body);
          const session = await auth.accountSession(req);
          if (!session)
            return json(res, 401, { error: "Доступ администратора отозван." });
          const actor = await auth.currentUser(req);
          if (!actor || actor.id !== session.accountId)
            return json(res, 403, { error: "Доступ администратора отозван." });
          const result = await db.postgresTransaction(async (client) => {
            // Match account deletion's account -> session order. Keep the
            // rights locked through the settings UPDATE and audit insertion.
            const account = await client.query(
              "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [session.accountId]);
            if (!account.rowCount) return { status: 401 as const };
            const active = await client.query<{ expires_at: string }>(
              `SELECT expires_at FROM account_sessions
               WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [session.tokenHash, session.accountId]);
            if (!active.rows[0] || Number(active.rows[0].expires_at) <= Date.now())
              return { status: 401 as const };
            await client.query("SELECT set_config('drevo.account_id',$1,true)",
              [session.accountId]);
            const membership = await client.query<{ approved: boolean }>(
              `SELECT approved FROM archive_memberships
               WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [db.archiveId, session.accountId]);
            const platformGrant = await client.query(
              "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
              [session.accountId]);
            if (!membership.rows[0]?.approved || !platformGrant.rowCount)
              return { status: 403 as const };
            return { status: 200 as const,
              settings: await backups.savePostgres(checked, actor, client) };
          });
          return json(res, result.status,
            result.status === 200 ? result.settings : { error: "Доступ администратора отозван." });
        }
        return json(
          res,
          200,
          await backups.save(body, (await auth.currentUser(req))!),
        );
      }
      if (path === "/api/backups/check" && req.method === "POST") {
        const body = await readJson(req);
        if (!(await auth.isPlatformAdmin(req)))
          return json(res, 403, { error: "Доступ администратора отозван." });
        if (!auth.local && db.kind === "postgres" && db.postgresTransaction) {
          const session = await auth.accountSession(req);
          if (!session)
            return json(res, 401, { error: "Доступ администратора отозван." });
          const actor = await auth.currentUser(req);
          if (!actor || actor.id !== session.accountId)
            return json(res, 403, { error: "Доступ администратора отозван." });
          return json(res, 202, await backups.check(body, actor, session));
        }
        return json(
          res,
          202,
          await backups.check(body, (await auth.currentUser(req))!),
        );
      }
      if (path === "/api/backups/create" && req.method === "POST") {
        if (downloading)
          throw new BackupBusyError("Дождитесь скачивания резервной копии.");
        return json(
          res,
          202,
          await backups.startCreate((await auth.currentUser(req))!),
        );
      }
      const match = path.match(
        /^\/api\/backups\/([a-f0-9-]{36})\/(preview|download)$/,
      );
      if (match?.[2] === "preview" && req.method === "POST") {
        const body = await readJson(req) as { restoreComments?: unknown };
        if (body?.restoreComments !== undefined && typeof body.restoreComments !== "boolean")
          throw new BackupInputError("Некорректный режим восстановления комментариев.");
        const inspect = async (file: string, signal: AbortSignal) => {
          const assertAccess = async () => {
            if (!(await auth.isPlatformAdmin(req)))
              throw new BackupInputError("Доступ администратора отозван.");
          };
          await assertAccess();
          return await restores.previewStream(
            createReadStream(file, { signal }),
            (await auth.currentUser(req))!,
            assertAccess,
            { restoreComments: body?.restoreComments === true },
          );
        };
        if (!auth.local && db.kind === "postgres" && db.postgresTransaction) {
          const session = await auth.accountSession(req);
          if (!session)
            return json(res, 401, { error: "Доступ администратора отозван." });
          const actor = await auth.currentUser(req);
          if (!actor || actor.id !== session.accountId)
            return json(res, 403, { error: "Доступ администратора отозван." });
          return json(res, 202, await backups.preview(match[1], actor, inspect, session));
        }
        return json(res, 202, await backups.preview(match[1],
          (await auth.currentUser(req))!, inspect));
      }
      if (match?.[2] === "download" && req.method === "GET") {
        if (
          downloading ||
          (await backups.status((await auth.currentUser(req))!.id)).job
            ?.state === "running"
        )
          throw new BackupBusyError(
            "Дождитесь завершения операции с резервными копиями.",
          );
        downloading = true;
        try {
          await backups.withFile(match[1], async (file, item) => {
            if (!(await auth.isPlatformAdmin(req)))
              throw new BackupInputError("Доступ администратора отозван.");
            const handle = await open(file, "r");
            const abort = new AbortController();
            const stop = () => {
              abort.abort();
              res.destroy();
            };
            let idleTimeout = setTimeout(stop, downloadIdleTimeoutMs);
            idleTimeout.unref();
            const progress = () => {
              clearTimeout(idleTimeout);
              idleTimeout = setTimeout(stop, downloadIdleTimeoutMs);
              idleTimeout.unref();
            };
            const maxTimeout = setTimeout(stop, downloadMaxTimeMs);
            maxTimeout.unref();
            res.on("drain", progress);
            // A disconnected client can close the response while the final DB check
            // is still running; attach the completion observer before any write.
            const delivered = finished(res, { cleanup: true }).catch(() => {});
            try {
              const first = Buffer.allocUnsafe(Math.min(firstChunkBytes, item.size));
              const { bytesRead } = await handle.read(first, 0, first.length, 0);
              if (!bytesRead)
                throw new BackupInputError("Резервная копия пуста. Обновите список.");
              await beforeDelivery?.();
              const sendFirst = () => {
                if (res.destroyed) return;
                res.writeHead(200, {
                  "Content-Type": "application/gzip",
                  "Content-Length": String(item.size),
                  "Content-Disposition": 'attachment; filename="' + item.name + '"',
                  "Cache-Control": "no-store",
                  "X-Content-Type-Options": "nosniff",
                });
                res.write(first.subarray(0, bytesRead));
                progress();
              };
              if (db.kind === "postgres" && db.postgresTransaction) {
                const session = await auth.accountSession(req);
                if (!session)
                  return json(res, 401, { error: "Доступ администратора отозван." });
                const delivered = await db.postgresTransaction(async (client) => {
                  // Match account deletion's account -> session order, then hold
                  // membership and platform grant through the first body write.
                  const account = await client.query(
                    "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [session.accountId]);
                  if (!account.rowCount)
                    return json(res, 401, { error: "Доступ администратора отозван." });
                  const active = await client.query<{ expires_at: string }>(
                    `SELECT expires_at FROM account_sessions
                     WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
                    [session.tokenHash, session.accountId]);
                  if (!active.rows[0] || Number(active.rows[0].expires_at) <= Date.now())
                    return json(res, 401, { error: "Доступ администратора отозван." });
                  await client.query("SELECT set_config('drevo.account_id',$1,true)",
                    [session.accountId]);
                  const membership = await client.query<{ approved: boolean }>(
                    `SELECT approved FROM archive_memberships
                     WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
                    [db.archiveId, session.accountId]);
                  const platformGrant = await client.query(
                    "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
                    [session.accountId]);
                  if (!membership.rows[0]?.approved || !platformGrant.rowCount)
                    return json(res, 403, { error: "Доступ администратора отозван." });
                  await beforeLockedDelivery?.();
                  sendFirst();
                  return true;
                });
                if (delivered !== true) return;
              } else {
                if (!(await auth.isPlatformAdmin(req)))
                  return json(res, (await auth.currentUser(req)) ? 403 : 401,
                    { error: "Доступ администратора отозван." });
                sendFirst();
              }
              if (res.destroyed) return;
              if (bytesRead >= item.size) res.end();
              else {
                const stream = handle.createReadStream({ start: bytesRead, autoClose: false,
                  signal: abort.signal });
                stream.on("data", progress);
                await pipeline(stream, res, { signal: abort.signal });
              }
              await delivered;
            } finally {
              clearTimeout(idleTimeout);
              clearTimeout(maxTimeout);
              res.off("drain", progress);
              await handle.close();
            }
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
      if (error instanceof BackupInputError || error instanceof BackupBusyError || error instanceof BackupAccessError)
        return json(res, error instanceof BackupAccessError ? error.status : error instanceof BackupBusyError ? 409 : 400, {
          error: error.message,
        });
      if ((error as { code?: string }).code === "55P03")
        return json(res, 409, { error: "Права доступа изменяются. Повторите запрос." });
      throw error;
    }
  };
}
