import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { accountArchiveDirectory } from "./account-archives.ts";

export function accountArchivesHttp(
  auth: Awaited<ReturnType<typeof createAuth>>,
  directory: ReturnType<typeof accountArchiveDirectory>,
) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/account/archives") return false;
    const send = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
      return true;
    };
    if (req.method !== "GET")
      return send(405, { error: "Метод не поддерживается" });
    const accountId = await auth.accountId(req);
    if (!accountId)
      return send(401, { error: "Войдите, чтобы увидеть свои деревья" });
    const archives = await directory.list(accountId);
    if (!archives)
      return send(501, { error: "Список деревьев доступен с PostgreSQL" });
    return send(200, { archives });
  };
}
