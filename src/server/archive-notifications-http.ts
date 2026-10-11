import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { openArchive } from "./database.ts";
import type { createAuth } from "./auth.ts";
import { archiveNotificationsStore } from "./archive-notifications.ts";
import { scopedArchiveReader } from "./scoped-archive-reader.ts";
import { isScopedUser } from "../domain/tree-access.ts";
import { memberPreviewTarget } from "./member-preview-access.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import {
  AccountSessionBusy,
  AccountSessionExpired,
  assertActiveAccountSession,
} from "./account-session-guard.ts";

export function archiveNotificationsHttp({
  archive,
  auth,
  publicOrigin,
  beforeDelivery,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
  beforeDelivery?: () => Promise<void>;
}) {
  const store = archiveNotificationsStore(archive.db);
  const scopedIds = scopedArchiveReader(archive);
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/notifications") return false;
    const initial = await auth.currentUser(req);
    if (!initial?.approved || memberPreviewTarget(req))
      return json(res, 401, {
        error: "Войдите в древо, чтобы открыть уведомления",
      });
    if (req.method !== "GET" && req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return json(res, 405, { error: "Метод не поддерживается" });
    }
    let receipt: { id?: number; through?: number } | null = null;
    const before = Number(url.searchParams.get("before") || 0);
    if (!Number.isSafeInteger(before) || before < 0)
      return json(res, 400, { error: "Некорректная страница" });
    if (req.method === "POST") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Недопустимый источник запроса" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "Ожидается JSON" });
      const chunks: Buffer[] = [];
      let size = 0;
      try {
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 512)
            return json(res, 413, { error: "Слишком большой запрос" });
          chunks.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !("id" in body || "through" in body)
        )
          throw new Error();
        const value = body.id ?? body.through;
        if (
          !Number.isSafeInteger(value) ||
          value < 0 ||
          ("id" in body && value === 0)
        )
          throw new Error();
        receipt = "id" in body ? { id: value } : { through: value };
      } catch {
        return json(res, 400, { error: "Некорректное уведомление" });
      }
    }
    await beforeDelivery?.();
    try {
      return await archive.db.transaction(
        async () => {
          if (!auth.local) {
            const session = await auth.accountSession(req);
            if (!session || session.accountId !== initial.id)
              return json(res, 401, { error: "Сеанс завершён" });
            await assertActiveAccountSession(
              archive.db,
              initial.id,
              session.tokenHash,
            );
            if (
              archive.db.kind === "postgres" &&
              !(await archive.db
                .prepare(
                  "",
                  "SELECT 1 FROM archive_memberships WHERE archive_id=? AND user_id=? FOR SHARE",
                )
                .get(archive.db.archiveId!, initial.id))
            )
              return json(res, 403, { error: "Доступ к древу отозван" });
          }
          const user = await auth.currentUser(req);
          if (!user?.approved || user.id !== initial.id)
            return json(res, 403, { error: "Доступ к древу отозван" });
          const visible = isScopedUser(user) ? await scopedIds(user) : null;
          if (
            receipt?.id !== undefined &&
            !(await store.read(user.id, visible, receipt.id))
          )
            return json(res, 404, { error: "Уведомление не найдено" });
          if (receipt?.through !== undefined)
            await store.readThrough(user.id, visible, receipt.through);
          const body = await store.list(user.id, visible, before);
          // Hold session/membership/archive locks only for this small response,
          // with a deadline so a slow reader cannot delay access revocation.
          const delivered = finished(res, { cleanup: true });
          const deadline = setTimeout(() => res.destroy(), 5_000);
          deadline.unref();
          try {
            json(res, 200, body);
            await delivered;
          } catch (error) {
            if (!res.destroyed) throw error;
          } finally {
            clearTimeout(deadline);
          }
          return true;
        },
        false,
        { archiveLock: "share" },
      );
    } catch (error) {
      if (res.headersSent || res.destroyed) return true;
      if (error instanceof AccountSessionExpired)
        return json(res, 401, { error: error.message });
      if (
        error instanceof AccountSessionBusy ||
        (error as { code?: string }).code === "55P03"
      )
        return json(res, 409, { error: "Доступ изменяется. Повторите запрос" });
      throw error;
    }
  };
}
