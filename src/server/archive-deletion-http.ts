import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import { archiveDeletion } from "./archive-deletion.ts";
import { ConflictError } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";

async function confirmation(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
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
    !("title" in value) ||
    typeof value.title !== "string" ||
    value.title.length > 200 ||
    !("removeCollaborators" in value) ||
    typeof value.removeCollaborators !== "boolean"
  )
    throw new SyntaxError("Некорректное подтверждение");
  return {
    title: value.title,
    removeCollaborators: value.removeCollaborators,
  };
}

export function archiveDeletionHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  databasePath: string,
  archiveId?: string,
  publicOrigin?: string,
) {
  const deletion = archiveDeletion(db, databasePath, archiveId);
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/account/archive-deletion") return false;
    const respond = (status: number, body: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
      return true;
    };
    if (!deletion.available)
      return respond(404, { error: "Удаление здесь недоступно" });
    const actor = await auth.currentUser(req);
    if (!actor) return respond(401, { error: "Требуется вход в дерево" });
    if (req.method !== "GET" && !isSameOriginRequest(req, publicOrigin))
      return respond(403, { error: "Недопустимый источник запроса" });
    if (
      req.method === "DELETE" &&
      req.headers["x-drevo-archive-deletion"] !== "1"
    )
      return respond(400, { error: "Откройте удаление в личном кабинете" });
    try {
      if (req.method === "GET") return respond(200, await deletion.plan(actor));
      if (req.method === "DELETE")
        return respond(
          200,
          await deletion.remove(actor, await confirmation(req)),
        );
      return respond(405, { error: "Неподдерживаемый метод" });
    } catch (error) {
      const status =
        error instanceof SyntaxError
          ? 400
          : error instanceof ForbiddenError
            ? 403
            : error instanceof ConflictError
              ? 409
              : 500;
      if (status === 500) console.error("archive_deletion_failed", error);
      return respond(status, {
        error:
          status === 500
            ? "Не удалось удалить дерево. Данные сохранены, попробуйте позже"
            : (error as Error).message,
      });
    }
  };
}
