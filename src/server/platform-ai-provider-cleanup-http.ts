import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import type { AiProviderCleanup } from "./ai-provider-cleanup.ts";
import { emptyCleanupJson } from "./ai-provider-cleanup-http.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { assertCurrentPlatformAdmin, PlatformAccessBusy,
  PlatformAccessDenied } from "./platform-access.ts";
import { aiCleanupStatusQuery, AiCleanupStatusInputError,
  aiProviderCleanupStatus, cleanupJobUuid,
  queueBlockedAiCleanup } from "./ai-provider-cleanup-status.ts";

/** Account-scoped operational queue. It never opens a family or an archive membership. */
export function platformAiProviderCleanupHttp({ auth, db, providerCleanup,
  publicOrigin, beforeAccessLock, afterAccessLock, beforeRetryDelivery }: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  providerCleanup?: Pick<AiProviderCleanup, "assertReady">;
  publicOrigin?: string;
  beforeAccessLock?: () => Promise<void>;
  afterAccessLock?: () => Promise<void>;
  beforeRetryDelivery?: () => Promise<void>;
}) {
  const send = async (res: ServerResponse, status: number, value: unknown,
    bounded = false, expiresAt = Infinity) => {
    const timeoutMs = Math.min(4_000,Math.max(1,expiresAt-Date.now()));
    const timer = bounded ? setTimeout(() => res.destroy(), timeoutMs) : null;
    timer?.unref();
    try {
      const delivered = bounded ? finished(res, { cleanup: true }) : null;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Robots-Tag": "noindex, nofollow, noarchive",
        "Referrer-Policy": "no-referrer",
      });
      res.end(JSON.stringify(value));
      if (delivered) await delivered;
    } finally { if (timer) clearTimeout(timer); }
    return true;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const retry = /^\/api\/platform\/ai\/cleanup\/([^/]+)\/retry$/.exec(url.pathname);
    if (url.pathname !== "/api/platform/ai/cleanup" && !retry) return false;
    if (db.kind !== "postgres" || !db.postgresTransaction || !providerCleanup)
      return send(res, 501, { error: "Долговечная очередь очистки требует PostgreSQL" });
    const session = await auth.accountSession(req);
    if (!session) return send(res, 401, { error: "Сеанс завершён" });
    if (!(await auth.isPlatformAdmin(req)))
      return send(res, 403, { error: "Очередь доступна администратору платформы" });
    if (retry) {
      if (req.method !== "POST") return send(res, 405, { error: "Ожидается POST" });
      if (!isSameOriginRequest(req, publicOrigin))
        return send(res, 403, { error: "Недопустимый источник запроса" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return send(res, 415, { error: "Ожидается JSON" });
      if (!cleanupJobUuid.test(retry[1]))
        return send(res, 400, { error: "Некорректное задание" });
      try {
        if (!(await emptyCleanupJson(req)))
          return send(res, 400, { error: "Ожидается пустой JSON" });
        await providerCleanup.assertReady();
        await beforeAccessLock?.();
        const result = await db.postgresTransaction(async (client) => {
          await client.query("SET LOCAL statement_timeout='2s'");
          await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
          await afterAccessLock?.();
          const active = await client.query<{ expires_at: number }>(
            "SELECT expires_at FROM account_sessions WHERE token_hash=$1 AND user_id=$2",
            [session.tokenHash, session.accountId]);
          const queued = await queueBlockedAiCleanup(client, retry[1],
            Number(active.rows[0]?.expires_at || 0));
          if (queued.status !== 202) return queued;
          // The audit belongs to the platform, not the archive that happened
          // to handle the request. Only the opaque local job UUID is recorded.
          await client.query(`INSERT INTO platform_config_audit(actor_id,action,item_id)
            VALUES($1,$2,$3)`, [session.accountId,"ai_provider_cleanup_retry",retry[1]]);
          return { status: 202 as const, queued: true,
            nextAttemptAt: queued.nextAttemptAt };
        });
        // The job-specific result is available only after the first transaction
        // commits. Guard its delivery too: 404/409 must not become an oracle
        // when the operator's grant changes between lookup and response.
        await beforeRetryDelivery?.();
        const delivered = await db.postgresTransaction(async (client) => {
          await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
          const active = await client.query<{ expires_at: number }>(
            "SELECT expires_at FROM account_sessions WHERE token_hash=$1 AND user_id=$2",
            [session.tokenHash, session.accountId]);
          const expiresAt = Number(active.rows[0]?.expires_at || 0);
          if (expiresAt <= Date.now())
            return send(res,401,{ error: "Сеанс завершён" });
          return send(res,result.status,result,true,expiresAt);
        });
        if (result.status === 202)
          console.info(JSON.stringify({ event: "ai.provider_cleanup_manual_retry", jobId: retry[1] }));
        return delivered;
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(); return true; }
        if (error instanceof RangeError)
          return send(res,413,{ error: "Слишком большой запрос" });
        if (error instanceof SyntaxError)
          return send(res,400,{ error: "Некорректный JSON" });
        if (error instanceof PlatformAccessBusy || (error as { code?: string }).code === "55P03")
          return send(res,409,{ error: "Права изменяются. Повторите запрос" });
        if (error instanceof PlatformAccessDenied)
          return send(res,403,{ error: "Доступ администратора отозван" });
        return send(res,503,{ error: "Не удалось поставить повтор в очередь" });
      }
    }
    if (req.method !== "GET") return send(res,405,{ error: "Ожидается GET" });
    try {
      const input = aiCleanupStatusQuery(url);
      await beforeAccessLock?.();
      return await db.postgresTransaction(async (client) => {
        await client.query("SET LOCAL statement_timeout='2s'");
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        await afterAccessLock?.();
        const status = await aiProviderCleanupStatus(client,input);
        const active = await client.query<{ expires_at: number }>(
          "SELECT expires_at FROM account_sessions WHERE token_hash=$1 AND user_id=$2",
          [session.tokenHash, session.accountId]);
        const expiresAt = Number(active.rows[0]?.expires_at || 0);
        if (expiresAt <= Date.now())
          return send(res,401,{ error: "Сеанс завершён" });
        return send(res,200,status,true,expiresAt);
      });
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return true; }
      if (error instanceof AiCleanupStatusInputError)
        return send(res,400,{ error: error.message });
      if (error instanceof PlatformAccessBusy || (error as { code?: string }).code === "55P03")
        return send(res,409,{ error: "Права изменяются. Повторите запрос" });
      if (error instanceof PlatformAccessDenied)
        return send(res,403,{ error: "Доступ администратора отозван" });
      return send(res,503,{ error: "Не удалось загрузить очередь очистки" });
    }
  };
}
