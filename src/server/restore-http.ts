import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { ConflictError } from "./database.ts";
import { RestoreTooLargeError, type RestoreStore } from "./restore.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import { UploadQuotaError } from "./upload-quota.ts";
import type { StoreDatabase } from "./store-database.ts";
import { isArchiveOwner } from "../domain/access.ts";

export function restoreHttp({
  restores,
  auth,
  publicOrigin,
}: {
  restores: RestoreStore;
  auth: Awaited<ReturnType<typeof createAuth>>;
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
    const archiveActor = await auth.currentUser(req);
    if (!archiveActor || !isArchiveOwner(archiveActor) || !archiveActor.approved || !(await auth.isPlatformAdmin(req)))
      return json(res, (await auth.accountId(req)) ? 403 : 401, {
        error: "Системное восстановление доступно администратору платформы",
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
        const actor = (await auth.currentUser(req))!;
        const result = await restores.previewStream(req, actor, async () => {
          const current = await auth.currentUser(req);
          if (!current || !(await auth.isPlatformAdmin(req)))
            throw new ForbiddenError("Доступ администратора отозван");
        }, { restoreComments: req.headers["x-drevo-restore-comments"] === "1" });
        return json(res, 200, result);
      }

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096)
          return json(res, 413, {
            error: "Запрос подтверждения слишком большой.",
          });
        chunks.push(Buffer.from(chunk));
      }
      const actor = await auth.currentUser(req);
      if (!actor || !(await auth.isPlatformAdmin(req)))
        return json(res, 403, { error: "Доступ администратора отозван" });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.confirm !== true || typeof body.token !== "string")
        return json(res, 400, { error: "Подтвердите замену данных" });
      const assertAccess = async (transaction?: StoreDatabase) => {
        const current = await auth.currentUser(req);
        if (!current || current.id !== actor.id || !(await auth.isPlatformAdmin(req)))
          throw new ForbiddenError("Доступ администратора платформы отозван");
        if (!auth.local && transaction?.kind === "postgres") {
          const locked = await transaction.prepare("", `SELECT 1 FROM platform_admins
            WHERE account_id=? FOR SHARE`).get(actor.id);
          if (!locked)
            throw new ForbiddenError("Доступ администратора платформы отозван");
        }
      };
      if (body.restoreComments !== undefined && typeof body.restoreComments !== "boolean")
        return json(res, 400, { error: "Некорректный режим восстановления комментариев." });
      return json(res, 200, await restores.apply(body.token, actor, assertAccess,
        body.restoreComments === true));
    } catch (error) {
      if (isInfrastructureError(error)) throw error;
      return json(
        res,
        error instanceof RestoreTooLargeError
          ? 413
          : error instanceof UploadQuotaError
            ? error.status
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
