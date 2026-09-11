import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { ConflictError } from "./database.ts";
import {
  RestoreTooLargeError,
  type RestoreStore,
} from "./restore.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";

export function restoreHttp({
  restores,
  auth,
  publicOrigin,
}: {
  restores: () => RestoreStore;
  auth: ReturnType<typeof createAuth>;
  publicOrigin?: string;
}) {
  let previewBusy = false;
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
    if (
      url.pathname !== "/api/restore/preview" &&
      url.pathname !== "/api/restore/apply"
    )
      return false;
    if (req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!auth.isAdmin(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "Импорт доступен только администратору",
      });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (req.headers["x-drevo-restore"] !== "1")
      return json(res, 400, { error: "Откройте импорт в админке" });

    const preview = url.pathname.endsWith("preview");
    if (preview && previewBusy)
      return json(res, 429, {
        error: "Уже загружается другой бэкап. Повторите позже.",
      });
    if (preview) previewBusy = true;

    try {
      if (preview) {
        const actor = auth.currentUser(req)!;
        const result = await restores().previewStream(req, actor, () => {
          const current = auth.currentUser(req);
          if (!current || current.role !== "admin")
            throw new ForbiddenError("Доступ администратора отозван");
        });
        return json(res, 200, result);
      }

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096)
          return json(res, 413, {
            error: "Файл слишком большой. Максимум 128 МБ.",
          });
        chunks.push(Buffer.from(chunk));
      }
      const actor = auth.currentUser(req);
      if (!actor || actor.role !== "admin")
        return json(res, 403, { error: "Доступ администратора отозван" });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.confirm !== true || typeof body.token !== "string")
        return json(res, 400, { error: "Подтвердите замену данных" });
      return json(res, 200, await restores().apply(body.token, actor));
    } catch (error) {
      return json(
        res,
        error instanceof RestoreTooLargeError
          ? 413
          : error instanceof ForbiddenError
            ? 403
            : error instanceof ConflictError
              ? 409
              : 400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось восстановить архив",
        },
      );
    } finally {
      if (preview) previewBusy = false;
    }
  };
}
