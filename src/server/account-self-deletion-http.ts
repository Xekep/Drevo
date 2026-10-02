import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import {
  accountSelfDeletion,
  AccountDeletionConflict,
  AccountDeletionSessionExpired,
} from "./account-self-deletion.ts";
import { removeDeletedAccountAiFiles } from "./account-deletion-files.ts";
import { isSameOriginRequest } from "./same-origin.ts";

async function readConfirmation(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new SyntaxError("Слишком большой запрос");
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SyntaxError("Некорректное подтверждение");
  }
  if (
    !value ||
    typeof value !== "object" ||
    !("name" in value) ||
    typeof value.name !== "string" ||
    value.name.length > 200 ||
    !("leaveSharedArchives" in value) ||
    typeof value.leaveSharedArchives !== "boolean" ||
    ("redactComments" in value && typeof value.redactComments !== "boolean")
  )
    throw new SyntaxError("Некорректное подтверждение");
  return {
    name: value.name,
    leaveSharedArchives: value.leaveSharedArchives,
    redactComments: "redactComments" in value && value.redactComments === true,
  };
}

export function accountSelfDeletionHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  enabled: boolean,
  publicOrigin?: string,
) {
  const deletion = accountSelfDeletion(db, enabled);
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/account/deletion") return false;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
      return true;
    };
    if (!deletion.available)
      return send(404, { error: "Удаление здесь недоступно" });
    const session = await auth.accountSession(req);
    if (!session) return send(401, { error: "Требуется вход в аккаунт" });
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return send(403, { error: "Недопустимый источник запроса" });
    if (
      req.method === "DELETE" &&
      req.headers["x-drevo-account-deletion"] !== "1"
    )
      return send(400, { error: "Откройте удаление в личном кабинете" });
    try {
      if (req.method === "GET") {
        const preview = await deletion.preview(session.accountId);
        return preview
          ? send(200, preview)
          : send(404, { error: "Аккаунт не найден" });
      }
      if (req.method === "DELETE") {
        const result = await deletion.remove(
          session.accountId,
          await readConfirmation(req),
          session.tokenHash,
        );
        await auth.logout(req, res);
        console.log(
          JSON.stringify({
            level: "info",
            event: "account_deleted",
            sharedArchives: result.sharedArchives,
            aiChatsToClean: result.aiChats.length,
          }),
        );
        const sent = send(200, {
          deleted: result.deleted,
          sharedArchives: result.sharedArchives,
        });
        // The account is gone; do not hold the response for a potentially
        // large recursive unlink. Startup/periodic orphan pruning retries if
        // this process exits or a filesystem operation fails.
        void removeDeletedAccountAiFiles(db, result.aiChats).catch((error) =>
          console.error("account_ai_file_cleanup_pending", error));
        return sent;
      }
      return send(405, { error: "Неподдерживаемый метод" });
    } catch (error) {
      const status =
        error instanceof SyntaxError
          ? 400
          : error instanceof AccountDeletionSessionExpired
            ? 401
            : error instanceof AccountDeletionConflict
              ? 409
              : 500;
      if (status === 500) console.error("account_deletion_failed", error);
      return send(status, {
        error:
          status === 500
            ? "Не удалось удалить аккаунт. Данные сохранены, попробуйте позже"
            : (error as Error).message,
      });
    }
  };
}
