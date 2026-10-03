import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import { accountDataExport, AccountAiHistoryTooLarge } from "./account-data-export.ts";
import type { StoreDatabase } from "./store-database.ts";

export function accountDataExportHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  beforeSend?: () => Promise<void>,
  deliveryDeadlineMs = 30_000,
) {
  const exporter = accountDataExport(db);
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/account/export") return false;
    const send = (status: number, value: unknown, download = false, json = JSON.stringify(value)) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...(download
          ? { "Content-Disposition": 'attachment; filename="drevo-account.json"' }
          : {}),
      });
      res.end(json);
      return true;
    };
    if (req.method !== "GET")
      return send(405, { error: "Метод не поддерживается" });
    if (db.kind !== "postgres")
      return send(404, { error: "Экспорт аккаунта здесь недоступен" });
    const session = await auth.accountSession(req);
    if (!session)
      return send(401, { error: "Требуется вход в аккаунт" });
    let prepared: Awaited<ReturnType<typeof exporter.read>> = null;
    let oversized: AccountAiHistoryTooLarge | null = null;
    try {
      prepared = await exporter.read(session.accountId);
    } catch (error) {
      if (error instanceof AccountAiHistoryTooLarge) oversized = error;
      else throw error;
    }
    if (!prepared && !oversized) return send(404, { error: "Аккаунт не найден" });
    const json = prepared ? JSON.stringify(prepared.download) : "";
    await beforeSend?.();
    let delivery: Awaited<ReturnType<typeof exporter.deliverWithCurrentSession>>;
    try {
      delivery = await exporter.deliverWithCurrentSession(
        session.accountId,
        session.tokenHash,
        oversized?.accessScopes ?? prepared!.accessScopes,
        async () => {
          const delivered = finished(res, { cleanup: true });
          const timer = setTimeout(
            () => res.destroy(new Error("Account JSON export delivery timed out")),
            deliveryDeadlineMs,
          );
          timer.unref();
          try {
            if (oversized)
              send(413, {
                error: "Экспорт не сформирован: история ИИ превышает текущий лимит. Данные не изменены.",
              });
            else
              send(200, prepared!.download, true, json);
            await delivered;
          } finally {
            clearTimeout(timer);
          }
        },
      );
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy(error as Error);
        return true;
      }
      throw error;
    }
    if (delivery === "session-expired")
      return send(401, { error: "Сеанс завершён. Войдите снова" });
    if (delivery === "access-changed")
      return send(409, { error: "Доступ к дереву изменился. Повторите экспорт" });
    if (delivery === "access-busy")
      return send(409, { error: "Права доступа меняются. Повторите экспорт" });
    return true;
  };
}
