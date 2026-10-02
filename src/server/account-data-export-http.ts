import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import { accountDataExport } from "./account-data-export.ts";
import type { StoreDatabase } from "./store-database.ts";

export function accountDataExportHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  beforeSend?: () => Promise<void>,
) {
  const exporter = accountDataExport(db);
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/account/export") return false;
    const send = (status: number, value: unknown, download = false) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        ...(download
          ? { "Content-Disposition": 'attachment; filename="drevo-account.json"' }
          : {}),
      });
      res.end(JSON.stringify(value));
      return true;
    };
    if (req.method !== "GET")
      return send(405, { error: "Метод не поддерживается" });
    if (db.kind !== "postgres")
      return send(404, { error: "Экспорт аккаунта здесь недоступен" });
    const accountId = await auth.accountId(req);
    if (!accountId)
      return send(401, { error: "Требуется вход в аккаунт" });
    const prepared = await exporter.read(accountId);
    if (!prepared) return send(404, { error: "Аккаунт не найден" });
    await beforeSend?.();
    if (await auth.accountId(req) !== accountId)
      return send(401, { error: "Сеанс завершён. Войдите снова" });
    if (!(await exporter.canDeliver(accountId, prepared.commentScopes)))
      return send(409, { error: "Доступ к дереву изменился. Повторите экспорт" });
    return send(200, prepared.download, true);
  };
}
