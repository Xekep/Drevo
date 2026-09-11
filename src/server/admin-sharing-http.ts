import type { IncomingMessage, ServerResponse } from "node:http";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import type { sharesStore } from "./shares.ts";
import type { auditStore } from "./audit.ts";
import { isSameOriginRequest } from "./same-origin.ts";

export function adminSharingHttp({
  archive,
  auth,
  shares,
  audit,
  publicOrigin,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  shares: ReturnType<typeof sharesStore>;
  audit: ReturnType<typeof auditStore>;
  publicOrigin?: string;
}) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex, nofollow, noarchive",
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
    if (
      path !== "/api/audit" &&
      path !== "/api/shares" &&
      !path.startsWith("/api/shares/")
    )
      return false;

    const actor = auth.currentUser(req);
    if (!actor || actor.role !== "admin")
      return json(res, actor ? 403 : 401, {
        error: "Доступно администратору",
      });

    if (path === "/api/audit" && req.method === "GET") {
      const before = Number(url.searchParams.get("before") || 0);
      if (!Number.isSafeInteger(before) || before < 0)
        return json(res, 400, { error: "Некорректная страница журнала" });
      return json(
        res,
        200,
        audit.list({
          before,
          personId: url.searchParams.get("personId") || undefined,
          actorId: url.searchParams.get("actorId") || undefined,
        }),
      );
    }

    if (path === "/api/shares" && req.method === "GET") {
      const before = url.searchParams.get("before") || "";
      if (!Number.isSafeInteger(Number(before)) || Number(before) < 0)
        return json(res, 400, { error: "Некорректная страница ссылок" });
      return json(res, 200, shares.list(before));
    }

    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });

    try {
      if (path.startsWith("/api/shares/") && req.method === "DELETE") {
        shares.revoke(
          decodeURIComponent(path.slice("/api/shares/".length)),
          actor,
        );
        return json(res, 200, { ok: true });
      }

      if (path === "/api/shares" && req.method === "POST") {
        if (!req.headers["content-type"]?.startsWith("application/json"))
          return json(res, 415, { error: "Ожидается JSON" });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1024 * 1024)
            return json(res, 413, { error: "Слишком большой запрос" });
          chunks.push(Buffer.from(chunk));
        }
        const currentActor = auth.currentUser(req);
        if (currentActor?.role !== "admin")
          return json(res, 403, { error: "Доступ отозван" });
        const current = archive.read();
        if (
          !req.headers["if-match"] ||
          Number(req.headers["if-match"]) !== current.revision
        )
          return json(res, 409, {
            error: "Архив изменился. Обновите древо и проверьте состав семьи.",
          });
        const result = shares.create(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          current.family,
          currentActor,
        );
        return json(res, 201, {
          share: result.share,
          path: `/s/${result.token}`,
        });
      }

      return json(res, 405, { error: "Метод не поддерживается" });
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  };
}
