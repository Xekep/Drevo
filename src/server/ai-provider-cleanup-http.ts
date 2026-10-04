import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import {
  aiCleanupStatusQuery,
  AiCleanupStatusInputError,
  aiProviderCleanupStatus,
} from "./ai-provider-cleanup-status.ts";

export function aiProviderCleanupHttp({
  auth,
  db,
  beforeAccessLock,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  beforeAccessLock?: () => Promise<void>;
}) {
  const send = async (
    res: ServerResponse,
    status: number,
    value: unknown,
    bounded = false,
  ) => {
    const timer = bounded ? setTimeout(() => res.destroy(), 4000) : null;
    timer?.unref();
    try {
      const delivered = bounded ? finished(res, { cleanup: true }) : null;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
      if (delivered) await delivered;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return true;
  };
  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    if (url.pathname !== "/api/admin/ai/cleanup") return false;
    if (!(await auth.isPlatformAdmin(req)))
      return send(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: "Очередь очистки доступна администратору платформы",
      });
    if (req.method !== "GET") return send(res, 405, { error: "Ожидается GET" });
    try {
      const input = aiCleanupStatusQuery(url);
      const actor = await auth.currentUser(req);
      if (!actor || !actor.approved)
        return send(res, 401, { error: "Сеанс завершён. Войдите снова" });
      await beforeAccessLock?.();
      if (db.kind !== "postgres" || !db.postgresTransaction) {
        if (!(await auth.isPlatformAdmin(req)))
          return send(res, 403, { error: "Доступ администратора отозван" });
        return send(res, 200, {
          supported: false,
          checkedAt: Date.now(),
          counts: { binding: 0, pending: 0, leased: 0, blocked: 0 },
          jobs: [],
          nextCursor: null,
        });
      }
      const session = auth.local ? null : await auth.accountSession(req);
      if (!auth.local && (!session || session.accountId !== actor.id))
        return send(res, 401, { error: "Сеанс завершён. Войдите снова" });
      return await db.postgresTransaction(async (client) => {
        await client.query("SET LOCAL statement_timeout='2s'");
        let expiresAt = Infinity;
        if (session) {
          const account = await client.query(
            "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT",
            [actor.id],
          );
          if (!account.rowCount)
            return send(res, 401, { error: "Сеанс завершён" });
          const active = await client.query(
            `SELECT expires_at FROM account_sessions
            WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [session.tokenHash, actor.id],
          );
          expiresAt = Number(active.rows[0]?.expires_at || 0);
          if (expiresAt <= Date.now())
            return send(res, 401, { error: "Сеанс завершён" });
          await client.query("SELECT set_config('drevo.account_id',$1,true)", [
            actor.id,
          ]);
          const member = await client.query(
            `SELECT approved FROM archive_memberships
            WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [db.archiveId, actor.id],
          );
          const grant = await client.query(
            "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
            [actor.id],
          );
          if (!member.rows[0]?.approved || !grant.rowCount)
            return send(res, 403, { error: "Доступ администратора отозван" });
        }
        const value = await aiProviderCleanupStatus(client, input);
        if (expiresAt <= Date.now())
          return send(res, 401, { error: "Сеанс завершён" });
        return send(res, 200, value, true);
      });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return true;
      }
      if (error instanceof AiCleanupStatusInputError)
        return send(res, 400, { error: error.message });
      const code = (error as { code?: string }).code;
      if (code === "55P03")
        return send(res, 409, { error: "Права изменяются. Повторите запрос" });
      return send(res, 503, {
        error: "Не удалось загрузить очередь очистки. Повторите запрос",
      });
    }
  };
}
