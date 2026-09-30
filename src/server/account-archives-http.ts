import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { accountArchiveDirectory } from "./account-archives.ts";
import type { StoreDatabase } from "./store-database.ts";
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
    const accountId = await auth.accountId(req);
    if (!accountId)
      return send(401, { error: "Войдите, чтобы увидеть свои деревья" });
    if (req.method === "POST") {
      if (!allowCreate || db.kind !== "postgres" || !db.postgresTransaction)
        return send(404, { error: "Создание дерева здесь недоступно" });
      if (!isSameOriginRequest(req, publicOrigin))
        return send(403, { error: "Недопустимый источник запроса" });
      if (req.headers["x-drevo-new-archive"] !== "1")
        return send(400, {
          error: "Откройте создание дерева в личном кабинете",
        });
      if (
        (req.headers["content-length"] !== undefined &&
          req.headers["content-length"] !== "0") ||
        req.headers["transfer-encoding"]
      )
        return send(400, { error: "Для создания дерева данные не нужны" });
      try {
        const archiveId = await db.postgresTransaction(async (client) => {
          const account = await client.query(
            "SELECT id FROM accounts WHERE id=$1 FOR UPDATE",
            [accountId],
          );
          if (!account.rowCount) throw new Error("Аккаунт не найден");
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
          : send(409, { error: "У аккаунта уже есть собственное дерево" });
      } catch (error) {
        console.error("account_archive_create_failed", error);
        return send(500, { error: "Не удалось создать дерево" });
      }
    }
    if (req.method !== "GET")
      return send(405, { error: "Метод не поддерживается" });
    const archives = await directory.list(accountId);
    if (!archives)
      return send(501, { error: "Список деревьев доступен с PostgreSQL" });
    return send(200, { archives });
  };
}
