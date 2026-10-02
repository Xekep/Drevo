import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { archiveOwnerTransfer } from "./archive-owner-transfer.ts";
import { AccountSessionBusy, AccountSessionExpired } from "./account-session-guard.ts";
import { ConflictError } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import type { StoreDatabase } from "./store-database.ts";
import { ForbiddenError } from "./users.ts";

async function readTarget(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new SyntaxError("Слишком большой запрос");
    chunks.push(Buffer.from(chunk));
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SyntaxError("Некорректные данные получателя");
  }
  const targetId =
    body && typeof body === "object" && "targetId" in body
      ? (body as { targetId: unknown }).targetId
      : null;
  if (typeof targetId !== "string" || !targetId || targetId.length > 200)
    throw new SyntaxError("Выберите участника дерева");
  return targetId;
}

export function archiveOwnerTransferHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  publicOrigin?: string,
) {
  const transfer = archiveOwnerTransfer(db);
  return async function handle(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ) {
    const path = url.pathname;
    if (
      path !== "/api/account/owner-transfer" &&
      path !== "/api/account/owner-transfer/candidates" &&
      path !== "/api/account/owner-transfer/accept"
    )
      return false;
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
      return true;
    };
    const actor = await auth.currentUser(req);
    if (!actor) return respond(401, { error: "Требуется вход в дерево" });
    const session = await auth.accountSession(req);
    if (!session || session.accountId !== actor.id)
      return respond(401, { error: "Сессия завершена. Войдите снова" });
    if (db.kind !== "postgres")
      return respond(404, { error: "Передача владения здесь недоступна" });
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return respond(403, { error: "Недопустимый источник запроса" });
    if (req.method !== "GET" && req.headers["x-drevo-owner-transfer"] !== "1")
      return respond(400, {
        error: "Откройте передачу владения в личном кабинете",
      });
    try {
      if (path.endsWith("/candidates") && req.method === "GET")
        return respond(
          200,
          await transfer.candidates(actor, url.searchParams.get("q") || ""),
        );
      if (path.endsWith("/accept") && req.method === "POST")
        return respond(200, await transfer.accept(actor, session.tokenHash));
      if (path === "/api/account/owner-transfer" && req.method === "GET")
        return respond(200, await transfer.status(actor));
      if (path === "/api/account/owner-transfer" && req.method === "POST")
        return respond(
          200,
          await transfer.propose(actor, await readTarget(req), session.tokenHash),
        );
      if (path === "/api/account/owner-transfer" && req.method === "DELETE")
        return respond(200, await transfer.cancel(actor, session.tokenHash));
      return respond(405, { error: "Неподдерживаемый метод" });
    } catch (error) {
      const status =
        error instanceof SyntaxError
          ? 400
          : error instanceof AccountSessionExpired
            ? 401
          : error instanceof AccountSessionBusy
            ? 409
          : error instanceof ForbiddenError
            ? 403
            : error instanceof ConflictError ||
                (error as { code?: string }).code === "23505"
              ? 409
              : 500;
      if (status === 500) console.error("owner_transfer_failed", error);
      return respond(status, {
        error:
          status === 500
            ? "Не удалось изменить владельца дерева"
            : (error as Error).message,
      });
    }
  };
}
