import { memberPreviewTarget } from "./member-preview-access.ts";
import { lockBackupStaff, assertTreeBackupInTransaction } from "./tree-backup-access.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { ConflictError } from "./database.ts";
import { RestoreTooLargeError, type RestoreStore } from "./restore.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";
import { isInfrastructureError } from "./infrastructure-error.ts";
import { UploadQuotaError } from "./upload-quota.ts";
import type { StoreDatabase } from "./store-database.ts";
import { canManageTreeBackups } from "../domain/access.ts";
import { finished } from "node:stream/promises";
import { assertActiveAccountSession, AccountSessionBusy, AccountSessionExpired } from "./account-session-guard.ts";
import { PlatformAccessBusy, PlatformAccessDenied } from "./platform-access.ts";

export function restoreHttp({
  restores,
  auth,
  db,
  publicOrigin,
  beforePreviewDelivery,
}: {
  restores: RestoreStore;
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  publicOrigin?: string;
  beforePreviewDelivery?: () => Promise<void>;
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
    if (!canManageTreeBackups(archiveActor) || !!memberPreviewTarget(req))
      return json(res, (await auth.accountId(req)) ? 403 : 401, {
        error: "Восстановление древа доступно его владельцу с ролью администратора или исследователя платформы",
      });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (req.headers["x-drevo-restore"] !== "1")
      return json(res, 400, { error: "Откройте восстановление в управлении древом" });

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
          if (!canManageTreeBackups(current) || (!canManageTreeBackups(await auth.currentUser(req)) || !!memberPreviewTarget(req)))
            throw new ForbiddenError("Доступ к резервным копиям древа отозван");
        }, { restoreComments: req.headers["x-drevo-restore-comments"] === "1" });
        await beforePreviewDelivery?.();
        if (!auth.local && db.kind === "postgres" && db.postgresTransaction) {
          const session = await auth.accountSession(req);
          if (!session || session.accountId !== actor.id)
            throw new AccountSessionExpired("Сессия завершена");
          return await db.postgresTransaction(async (client) => {
            const account = await client.query("SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [actor.id]);
            const active = await client.query<{ expires_at: string }>(
              "SELECT expires_at FROM account_sessions WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT",
              [session.tokenHash, actor.id]);
            await client.query("SELECT set_config('drevo.account_id',$1,true)", [actor.id]);
            const member = await client.query<{ approved: boolean }>(
              "SELECT approved FROM archive_memberships WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT",
              [db.archiveId, actor.id]);
            const owner = await client.query(
              "SELECT user_id FROM archive_owners WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT",
              [db.archiveId, actor.id]);
            const admin = await lockBackupStaff(client, actor.id);
            if (!account.rowCount || !active.rows[0] || Number(active.rows[0].expires_at) <= Date.now())
              throw new AccountSessionExpired("Сессия завершена");
            if (!member.rows[0]?.approved || !owner.rowCount || !admin)
              throw new ForbiddenError("Доступ к архиву отозван");
            const completed = finished(res, { cleanup: true }).catch(() => {});
            const timeout = setTimeout(() => res.destroy(), 5000);
            timeout.unref();
            try {
              json(res, 200, result);
              await completed;
            } finally { clearTimeout(timeout); }
            return true;
          });
        }
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
      if (!actor || (!canManageTreeBackups(await auth.currentUser(req)) || !!memberPreviewTarget(req)))
        return json(res, 403, { error: "Доступ к резервным копиям древа отозван" });
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body.confirm !== true || typeof body.token !== "string")
        return json(res, 400, { error: "Подтвердите замену данных" });
      const actorSession = !auth.local && db.kind === "postgres"
        ? await auth.accountSession(req) : null;
      const assertAccess = async (transaction?: StoreDatabase) => {
        if (!auth.local && transaction?.kind === "postgres") {
          if (!actorSession || actorSession.accountId !== actor.id)
            throw new AccountSessionExpired("Сессия завершена");
          await assertActiveAccountSession(transaction, actor.id, actorSession.tokenHash);
          await assertTreeBackupInTransaction(transaction, actor.id);
          return;
        }
        const current = await auth.currentUser(req);
        if (!canManageTreeBackups(current) || current.id !== actor.id || (!canManageTreeBackups(await auth.currentUser(req)) || !!memberPreviewTarget(req)))
          throw new ForbiddenError("Доступ администратора платформы отозван");
      };
      if (body.restoreComments !== undefined && typeof body.restoreComments !== "boolean")
        return json(res, 400, { error: "Некорректный режим восстановления комментариев." });
      return json(res, 200, await restores.apply(body.token, actor, assertAccess,
        body.restoreComments === true));
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return true;
      }
      if (isInfrastructureError(error)) throw error;
      return json(
        res,
        error instanceof RestoreTooLargeError
          ? 413
          : error instanceof UploadQuotaError
            ? error.status
            : error instanceof AccountSessionExpired
              ? 401
              : error instanceof AccountSessionBusy || error instanceof PlatformAccessBusy ||
                  (error as { code?: string }).code === "55P03"
                ? 409
              : error instanceof ForbiddenError || error instanceof PlatformAccessDenied
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
