import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { accountArchiveDirectory } from "./account-archives.ts";
import { AccountArchiveListChanged } from "./account-archives.ts";
import type { StoreDatabase } from "./store-database.ts";
import { AccountSessionBusy, AccountSessionExpired } from "./account-session-guard.ts";
import { randomUUID } from "node:crypto";
import { ARCHIVE_SCHEMA_VERSION } from "./schema.ts";
import { provisionPrivateArchiveInTransaction } from "./postgres-private-archive.ts";
import { isSameOriginRequest } from "./same-origin.ts";

export function accountArchivesHttp(
  auth: Awaited<ReturnType<typeof createAuth>>,
  directory: ReturnType<typeof accountArchiveDirectory>,
  db: StoreDatabase,
  publicOrigin?: string,
  allowCreate = false,
) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/account/archives") return false;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
      return true;
    };
    const requiresSession = req.method === "GET" || req.method === "POST";
    const session = requiresSession ? await auth.accountSession(req) : null;
    const accountId = requiresSession
      ? session?.accountId
      : await auth.accountId(req);
    if (!accountId)
      return send(401, { error: "Войдите, чтобы увидеть свои древа" });
    if (req.method === "POST") {
      if (!allowCreate || db.kind !== "postgres" || !db.postgresTransaction)
        return send(404, { error: "Создание древа здесь недоступно" });
      if (!isSameOriginRequest(req, publicOrigin))
        return send(403, { error: "Недопустимый источник запроса" });
      if (req.headers["x-drevo-new-archive"] !== "1")
        return send(400, {
          error: "Откройте создание древа в личном кабинете",
        });
      if (
        (req.headers["content-length"] !== undefined &&
          req.headers["content-length"] !== "0") ||
        req.headers["transfer-encoding"]
      )
        return send(400, { error: "Для создания древа данные не нужны" });
      try {
        const archiveId = await db.postgresTransaction(async (client) => {
          const account = await client.query(
            "SELECT id FROM accounts WHERE id=$1 FOR UPDATE",
            [accountId],
          );
          if (!account.rowCount) throw new AccountSessionExpired("Аккаунт не найден");
          // Account deletion takes account -> session locks too. A revoke that
          // won the session lock first makes this request retry or fail closed.
          let sessionExpiresAt = NaN;
          try {
            const currentSession = await client.query<{ expires_at: string }>(
              `SELECT expires_at FROM account_sessions
               WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
              [session!.tokenHash, accountId],
            );
            sessionExpiresAt = Number(currentSession.rows[0]?.expires_at);
          } catch (error) {
            if ((error as { code?: string }).code === "55P03")
              throw new AccountSessionBusy("Сеанс занят другим действием. Повторите запрос");
            throw error;
          }
          if (!Number.isFinite(sessionExpiresAt) || sessionExpiresAt <= Date.now())
            throw new AccountSessionExpired("Сессия завершена. Войдите снова");
          await client.query("SELECT set_config('drevo.account_id',$1,true)", [
            accountId,
          ]);
          const owned = await client.query(
            "SELECT 1 FROM archive_owners WHERE user_id=$1",
            [accountId],
          );
          if (owned.rowCount) return null;
          const id = randomUUID();
          await client.query("SELECT set_config('drevo.archive_id',$1,true)", [
            id,
          ]);
          await provisionPrivateArchiveInTransaction(
            client,
            accountId,
            id,
            "Моё древо",
            ARCHIVE_SCHEMA_VERSION,
          );
          return id;
        });
        return archiveId
          ? send(201, { archiveId })
          : send(409, { error: "У аккаунта уже есть собственное древо" });
      } catch (error) {
        if (error instanceof AccountSessionExpired)
          return send(401, { error: error.message });
        if (error instanceof AccountSessionBusy)
          return send(409, { error: error.message });
        console.error("account_archive_create_failed", error);
        return send(500, { error: "Не удалось создать древо" });
      }
    }
    if (req.method !== "GET")
      return send(405, { error: "Метод не поддерживается" });
    const archives = await directory.list(accountId);
    if (!archives)
      return send(501, { error: "Список древ доступен с PostgreSQL" });
    const body = JSON.stringify({ archives });
    try {
      await directory.deliverList(accountId, session!.tokenHash, archives, async () => {
        const timeout = setTimeout(() => res.destroy(new Error("Archive list delivery timed out")), 4_000);
        timeout.unref();
        try {
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          const delivered = finished(res, { cleanup: true });
          res.end(body);
          await delivered;
        } finally {
          clearTimeout(timeout);
        }
      });
      return true;
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy(error as Error);
        return true;
      }
      if (error instanceof AccountSessionExpired)
        return send(401, { error: error.message });
      if (error instanceof AccountSessionBusy || error instanceof AccountArchiveListChanged)
        return send(409, { error: error.message });
      throw error;
    }
  };
}
