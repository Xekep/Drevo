import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { accountCapacity } from "./account-capacity.ts";

export function coreHttp({
  archive,
  auth,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
}) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname;
    if (path === "/api/health" && req.method === "GET")
      return json(res, 200, {
        ok: true,
        revision: (await archive.meta()).revision,
      });

    if (path === "/api/login")
      return json(res, 404, { error: "Password sign-in has been removed" });

    if (path === "/api/account/sessions" && req.method === "GET") {
      const sessions = await auth.sessionSummary(req);
      return sessions
        ? json(res, 200, sessions)
        : json(res, 401, { error: "Требуется вход" });
    }

    if (path === "/api/account/capacity" && req.method === "GET") {
      const user = await auth.currentUser(req);
      return user
        ? json(res, 200, await accountCapacity(archive.db, user.id))
        : json(res, 401, { error: "Требуется вход" });
    }

    if (
      path === "/api/account/sessions/revoke-others" &&
      req.method === "POST"
    ) {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      const revoked = await auth.revokeOtherSessions(req);
      return revoked === null
        ? json(res, 401, { error: "Требуется вход" })
        : json(res, 200, { revoked });
    }

    const managedSession = path.match(
      /^\/api\/account\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/revoke$/i,
    );
    if (managedSession && req.method === "POST") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      const revoked = await auth.revokeManagedSession(
        req,
        managedSession[1].toLowerCase(),
      );
      if (revoked === null) return json(res, 401, { error: "Требуется вход" });
      if (revoked === "current")
        return json(res, 409, {
          error: "Для выхода из текущего сеанса используйте кнопку «Выйти».",
        });
      return json(res, 200, { revoked });
    }

    if (path === "/auth/logout" && req.method === "POST") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      await auth.logout(req, res);
      return json(res, 200, { ok: true });
    }

    return false;
  };
}
