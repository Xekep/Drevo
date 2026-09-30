import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import {
  accountInvitations,
  InvalidInvitationError,
} from "./archive-invitations.ts";
import { isSameOriginRequest } from "./same-origin.ts";

/** The root account session can accept a link without prior archive membership. */
export function accountInvitationsHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  publicOrigin?: string,
) {
  const invitations = accountInvitations(db);
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const preview = url.pathname === "/api/account/invitations/preview";
    const accept = url.pathname === "/api/account/invitations/accept";
    if (!preview && !accept) return false;
    if (req.method !== "POST")
      return json(res, 405, { error: "Метод не поддерживается." });
    if (db.kind !== "postgres")
      return json(res, 501, { error: "Приглашения доступны с PostgreSQL." });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса." });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: "Ожидается JSON." });
    const accountId = accept ? await auth.accountId(req) : null;
    if (accept && !accountId)
      return json(res, 401, { error: "Войдите, чтобы принять приглашение." });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 4096)
        return json(res, 413, { error: "Запрос слишком большой." });
      chunks.push(Buffer.from(chunk));
    }
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        typeof input?.archiveId !== "string" ||
        typeof input?.token !== "string"
      )
        throw new InvalidInvitationError("Приглашение недействительно.");
      return json(
        res,
        200,
        accept
          ? await invitations.accept(input.archiveId, input.token, accountId!)
          : await invitations.preview(input.archiveId, input.token),
      );
    } catch (error) {
      if (error instanceof InvalidInvitationError)
        return json(res, 410, { error: error.message });
      if (error instanceof SyntaxError)
        return json(res, 400, { error: "Некорректный JSON." });
      throw error;
    }
  };
}
