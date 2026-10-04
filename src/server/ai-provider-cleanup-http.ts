import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import type { AiProviderCleanup } from "./ai-provider-cleanup.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import {
  aiCleanupStatusQuery,
  AiCleanupStatusInputError,
  aiProviderCleanupStatus,
  queueBlockedAiCleanup,
  cleanupJobUuid,
} from "./ai-provider-cleanup-status.ts";

export async function emptyCleanupJson(req: IncomingMessage) {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024) throw new RangeError("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 0;
}

export function aiProviderCleanupHttp({
  auth,
  db,
  providerCleanup,
  publicOrigin,
  beforeAccessLock,
  afterAccessLock,
  beforeRetryDelivery,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  providerCleanup?: Pick<AiProviderCleanup, "assertReady">;
  publicOrigin?: string;
  beforeAccessLock?: () => Promise<void>;
  afterAccessLock?: () => Promise<void>;
  beforeRetryDelivery?: () => Promise<void>;
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
    const retry = /^\/api\/admin\/ai\/cleanup\/([^/]+)\/retry$/.exec(url.pathname);
    if (url.pathname !== "/api/admin/ai/cleanup" && !retry) return false;
    if (!(await auth.isPlatformAdmin(req)))
      return send(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: "Очередь очистки доступна администратору платформы",
      });
    if (retry) {
      if (req.method !== "POST") return send(res, 405, { error: "Ожидается POST" });
      if (!isSameOriginRequest(req, publicOrigin))
        return send(res, 403, { error: "Invalid origin" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return send(res, 415, { error: "JSON required" });
      if (!cleanupJobUuid.test(retry[1]))
        return send(res, 400, { error: "Некорректное задание" });
      try {
        if (!(await emptyCleanupJson(req)))
          return send(res, 400, { error: "Ожидается пустой JSON" });
        const actor = await auth.currentUser(req);
        if (!actor || !actor.approved)
          return send(res, 401, { error: "Сеанс завершён. Войдите снова" });
        if (auth.local || db.kind !== "postgres" || !db.postgresTransaction || !providerCleanup)
          return send(res, 503, { error: "Очередь очистки недоступна" });
        await providerCleanup.assertReady();
        const session = await auth.accountSession(req);
        if (!session || session.accountId !== actor.id)
          return send(res, 401, { error: "Сеанс завершён. Войдите снова" });
        await beforeAccessLock?.();
        const result = await db.postgresTransaction(async (client) => {
          await client.query("SET LOCAL statement_timeout='2s'");
          const account = await client.query<{ name: string }>(
            "SELECT name FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [actor.id]);
          if (!account.rowCount)
            return { status: 401, error: "Сеанс завершён" };
          const active = await client.query<{ expires_at: number }>(
            `SELECT expires_at FROM account_sessions
             WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [session.tokenHash, actor.id]);
          const expiresAt = Number(active.rows[0]?.expires_at || 0);
          if (expiresAt <= Date.now())
            return { status: 401, error: "Сеанс завершён" };
          await client.query("SELECT set_config('drevo.account_id',$1,true)", [actor.id]);
          const member = await client.query<{ approved: boolean }>(
            `SELECT approved FROM archive_memberships
             WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [db.archiveId, actor.id]);
          const grant = await client.query(
            "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
            [actor.id]);
          if (!member.rows[0]?.approved || !grant.rowCount)
            return { status: 403, error: "Доступ администратора отозван" };
          await afterAccessLock?.();
          const queued = await queueBlockedAiCleanup(client, retry[1], expiresAt);
          if (queued.status !== 202) return queued;
          await client.query(
            `INSERT INTO archive_audit_entries
             (archive_id,at,actor_id,actor_name,action,entity,entity_id,label,revision,details)
             VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,'[]'::jsonb)`,
            [db.archiveId, new Date(queued.now).toISOString(), actor.id,
              String(account.rows[0].name), "Повтор очистки поставлен в очередь",
              "ai_provider_cleanup", "retry", "Очистка диалогов у провайдера"],
          );
          return { status: 202, queued: true, nextAttemptAt: queued.nextAttemptAt };
        });
        await beforeRetryDelivery?.();
        const delivered = await db.postgresTransaction(async (client) => {
          await client.query("SET LOCAL statement_timeout='2s'");
          const account = await client.query(
            "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [actor.id]);
          if (!account.rowCount)
            return send(res, 401, { error: "Сеанс завершён" });
          const active = await client.query<{ expires_at: number }>(
            `SELECT expires_at FROM account_sessions
             WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [session.tokenHash, actor.id]);
          if (!active.rowCount || Number(active.rows[0].expires_at) <= Date.now())
            return send(res, 401, { error: "Сеанс завершён" });
          await client.query("SELECT set_config('drevo.account_id',$1,true)", [actor.id]);
          const member = await client.query<{ approved: boolean }>(
            `SELECT approved FROM archive_memberships
             WHERE archive_id=$1 AND user_id=$2 FOR SHARE NOWAIT`,
            [db.archiveId, actor.id]);
          const grant = await client.query(
            "SELECT account_id FROM platform_admins WHERE account_id=$1 FOR SHARE NOWAIT",
            [actor.id]);
          if (!member.rows[0]?.approved || !grant.rowCount)
            return send(res, 403, { error: "Доступ администратора отозван" });
          return send(res, result.status, result, true);
        });
        if (result.status === 202)
          console.info(JSON.stringify({ event: "ai.provider_cleanup_manual_retry", jobId: retry[1] }));
        return delivered;
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(); return true; }
        if (error instanceof RangeError)
          return send(res, 413, { error: "Слишком большой запрос" });
        if (error instanceof SyntaxError)
          return send(res, 400, { error: "Некорректный JSON" });
        if ((error as { code?: string }).code === "55P03")
          return send(res, 409, { error: "Права изменяются. Повторите запрос" });
        return send(res, 503, { error: "Не удалось поставить повтор в очередь" });
      }
    }
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
