import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import {
  accountInvitations,
  InvalidInvitationError,
} from "./archive-invitations.ts";
import { AccountSessionBusy, AccountSessionExpired } from "./account-session-guard.ts";
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
    const session = accept ? await auth.accountSession(req) : null;
    if (accept && !session)
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
      if (preview) {
        // Keep the archive and invitation locks until this small HTTP
        // response has finished, so a completed revoke cannot leak it.
        await invitations.deliverPreview(input.archiveId, input.token, async (value) => {
          const timeout = setTimeout(() => res.destroy(new Error("Invitation preview timed out")), 4_000);
          timeout.unref();
          try {
            json(res, 200, value);
            await finished(res);
          } finally {
            clearTimeout(timeout);
          }
        });
        return true;
      }
      return json(res, 200,
        await invitations.accept(input.archiveId, input.token, session!.accountId, session!.tokenHash));
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy(error as Error);
        return true;
      }
      if (error instanceof AccountSessionExpired)
        return json(res, 401, { error: error.message });
      if (error instanceof AccountSessionBusy)
        return json(res, 409, { error: error.message });
      if (error instanceof InvalidInvitationError)
        return json(res, 410, { error: error.message });
      if (error instanceof SyntaxError)
        return json(res, 400, { error: "Некорректный JSON." });
      throw error;
    }
  };
}
