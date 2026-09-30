import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import {
  archiveInvitations,
  InvalidInvitationError,
} from "./archive-invitations.ts";
import { ForbiddenError } from "./users.ts";
import { isSameOriginRequest } from "./same-origin.ts";

export function archiveInvitationsHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  publicOrigin?: string,
) {
  const invitations = archiveInvitations(db);
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const path = url.pathname;
    if (path !== "/api/invitations" && !path.startsWith("/api/invitations/"))
      return false;
    const actor = await auth.currentUser(req);
    if (!actor?.approved || actor.role !== "admin")
      return json(res, actor ? 403 : 401, {
        error: "Доступно администратору дерева.",
      });
    if (db.kind !== "postgres")
      return json(res, 501, { error: "Приглашения доступны с PostgreSQL." });
    try {
      if (path === "/api/invitations" && req.method === "GET")
        return json(res, 200, { invitations: await invitations.list(actor) });
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Недопустимый источник запроса." });
      if (path === "/api/invitations" && req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "Ожидается JSON." });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 4096)
            return json(res, 413, { error: "Запрос слишком большой." });
          chunks.push(Buffer.from(chunk));
        }
        const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (!input || typeof input !== "object")
          throw new InvalidInvitationError("Выберите роль и срок приглашения.");
        return json(
          res,
          201,
          await invitations.create(actor, input.role, input.durationHours),
        );
      }
      const id = /^\/api\/invitations\/([a-f0-9-]{36})$/.exec(path)?.[1];
      if (id && req.method === "DELETE") {
        const revoked = await invitations.revoke(actor, id);
        return json(
          res,
          revoked ? 200 : 404,
          revoked ? { ok: true } : { error: "Приглашение не найдено." },
        );
      }
      return json(res, 405, { error: "Метод не поддерживается." });
    } catch (error) {
      if (error instanceof ForbiddenError)
        return json(res, 403, { error: error.message });
      if (
        error instanceof InvalidInvitationError ||
        error instanceof SyntaxError
      )
        return json(res, 400, { error: error.message });
      throw error;
    }
  };
}
