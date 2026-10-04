import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type pg from "pg";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { assertCurrentPlatformAdmin, PlatformAccessBusy,
  PlatformAccessDenied } from "./platform-access.ts";
import { platformOwnedArchiveCapacity } from "./account-capacity.ts";

const PAGE_SIZE = 30;

async function requestedTier(req: IncomingMessage) {
  if (!req.headers["content-type"]?.startsWith("application/json"))
    throw new TypeError("Ожидается JSON");
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2048) throw new RangeError("Слишком большой запрос");
    chunks.push(Buffer.from(chunk));
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "expectedFullAccess" && key !== "fullAccess") ||
      typeof (body as { expectedFullAccess?: unknown }).expectedFullAccess !== "boolean" ||
      typeof (body as { fullAccess?: unknown }).fullAccess !== "boolean")
    throw new TypeError("Укажите текущий и новый уровень доступа");
  return body as { expectedFullAccess: boolean; fullAccess: boolean };
}

/** Global account tiers never imply archive membership, ownership or staff roles. */
export function platformTiersHttp(db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>, publicOrigin?: string,
  hooks: { beforeAccessLock?: () => Promise<void>;
    beforeUsageOwnerLock?: () => Promise<void>;
    beforeReadDelivery?: (client: pg.PoolClient) => Promise<void>;
    afterMutationCommit?: () => Promise<void> } = {}) {
  const send = async (res: ServerResponse, status: number, value: unknown,
    guarded?: { client: pg.PoolClient; accountId: string; tokenHash: string }) => {
    const body = JSON.stringify(value);
    let deadlineMs = 4_000;
    if (guarded) {
      // A read may have spent time counting, and a write has already committed.
      // Recheck under fresh/retained account, session and grant locks immediately
      // before bytes; keep those locks until delivery finishes or aborts.
      await assertCurrentPlatformAdmin(guarded.client, guarded.accountId,
        guarded.tokenHash);
      const session = await guarded.client.query<{ expires_at: string }>(
        `SELECT expires_at FROM account_sessions
         WHERE token_hash=$1 AND user_id=$2 FOR SHARE NOWAIT`,
        [guarded.tokenHash, guarded.accountId]);
      deadlineMs = Math.min(deadlineMs, Number(session.rows[0].expires_at) - Date.now());
      if (deadlineMs <= 0)
        throw new PlatformAccessDenied("Сеанс завершён");
    }
    const timer = guarded ? setTimeout(() =>
      res.destroy(new Error("Platform tier delivery timed out")), deadlineMs) : null;
    timer?.unref();
    try {
      const done = guarded ? finished(res, { cleanup: true }) : null;
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
      res.end(body);
      if (done) await done;
    } finally { if (timer) clearTimeout(timer); }
    return true;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/platform/tiers" &&
        !/^\/api\/platform\/tiers\/[^/]+(?:\/usage)?$/.test(url.pathname)) return false;
    if (db.kind !== "postgres" || !db.postgresTransaction)
      return send(res, 501, { error: "Уровни аккаунтов доступны с PostgreSQL" });
    const session = await auth.accountSession(req);
    if (!session) return send(res, 401, { error: "Сеанс завершён" });
    const guarded = (client: pg.PoolClient) => ({ client,
      accountId: session.accountId, tokenHash: session.tokenHash });
    try {
      await hooks.beforeAccessLock?.();
      if (url.pathname === "/api/platform/tiers" && req.method === "GET") {
        const after = url.searchParams.get("after") || "";
        if (after.length > 200)
          return send(res, 400, { error: "Некорректная страница" });
        return await db.postgresTransaction(async (client) => {
          await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
          await client.query("SET LOCAL statement_timeout='3s'");
          const rows = await client.query<{ id: string; name: string; full_access: boolean }>(
            `SELECT a.id,a.name,t.full_access FROM accounts a
             JOIN account_tiers t ON t.account_id=a.id
             WHERE a.id COLLATE "C" > $1 COLLATE "C"
             ORDER BY a.id COLLATE "C" LIMIT $2
             FOR SHARE OF a,t NOWAIT`, [after, PAGE_SIZE + 1]);
          const items = rows.rows.slice(0, PAGE_SIZE).map((row) => ({
            id: row.id, name: row.name, fullAccess: row.full_access }));
          const totals = await client.query<{ basic: string; full: string }>(
            `SELECT count(*) FILTER (WHERE NOT full_access)::text AS basic,
              count(*) FILTER (WHERE full_access)::text AS full FROM account_tiers`);
          await hooks.beforeReadDelivery?.(client);
          return send(res, 200, { accounts: items,
            next: rows.rows.length > PAGE_SIZE ? items.at(-1)?.id : null,
            totals: { basic: Number(totals.rows[0].basic), full: Number(totals.rows[0].full) },
          }, guarded(client));
        });
      }
      const usagePath = /^\/api\/platform\/tiers\/([^/]+)\/usage$/.exec(url.pathname);
      if (usagePath) {
        if (req.method !== "GET")
          return send(res, 405, { error: "Метод не поддерживается" });
        const accountId = decodeURIComponent(usagePath[1]);
        if (!accountId || accountId.length > 200)
          return send(res, 400, { error: "Некорректный аккаунт" });
        return await db.postgresTransaction(async (client) => {
          await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
          const account = await client.query(
            "SELECT id FROM accounts WHERE id=$1 FOR SHARE NOWAIT", [accountId]);
          if (!account.rowCount) return send(res, 404,
            { error: "Аккаунт не найден" }, guarded(client));
          const usage = await platformOwnedArchiveCapacity(client, accountId,
            hooks.beforeUsageOwnerLock);
          await hooks.beforeReadDelivery?.(client);
          return send(res, 200, { accountId, ...usage }, guarded(client));
        });
      }
      const targetId = url.pathname.startsWith("/api/platform/tiers/")
        ? decodeURIComponent(url.pathname.slice("/api/platform/tiers/".length)) : "";
      if (!targetId) return send(res, 405, { error: "Метод не поддерживается" });
      if (targetId.length > 200)
        return send(res, 400, { error: "Некорректный аккаунт" });
      if (req.method === "GET")
        return await db.postgresTransaction(async (client) => {
          await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
          await client.query("SET LOCAL statement_timeout='3s'");
          const tier = await client.query<{ full_access: boolean }>(
            `SELECT t.full_access FROM accounts a
             JOIN account_tiers t ON t.account_id=a.id WHERE a.id=$1
             FOR SHARE OF a,t NOWAIT`, [targetId]);
          await hooks.beforeReadDelivery?.(client);
          return tier.rowCount
            ? send(res, 200, { accountId: targetId,
              fullAccess: tier.rows[0].full_access }, guarded(client))
            : send(res, 404, { error: "Аккаунт не найден" }, guarded(client));
        });
      if (req.method !== "PATCH")
        return send(res, 405, { error: "Метод не поддерживается" });
      if (!isSameOriginRequest(req, publicOrigin))
        return send(res, 403, { error: "Недопустимый источник запроса" });
      const input = await requestedTier(req);
      const result = await db.postgresTransaction(async (client) => {
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        const target = await client.query(`SELECT id FROM accounts WHERE id=$1
          FOR UPDATE NOWAIT`, [targetId]);
        if (!target.rowCount) return { status: 404 as const };
        const tier = await client.query<{ full_access: boolean }>(
          `SELECT full_access FROM account_tiers WHERE account_id=$1
           FOR UPDATE NOWAIT`, [targetId]);
        if (!tier.rowCount) return { status: 409 as const };
        const before = tier.rows[0].full_access;
        if (before !== input.expectedFullAccess)
          return { status: 409 as const };
        if (before !== input.fullAccess) {
          await client.query(`UPDATE account_tiers SET full_access=$2,
            changed_at=clock_timestamp() WHERE account_id=$1`,
          [targetId,input.fullAccess]);
          await client.query(`INSERT INTO platform_config_audit(actor_id,action,item_id)
            VALUES($1,$2,$3)`, [session.accountId,
            input.fullAccess ? "account_tier_enable_full" : "account_tier_disable_full", targetId]);
        }
        return { status: 200 as const, changed: before !== input.fullAccess };
      });
      await hooks.afterMutationCommit?.();
      return await db.postgresTransaction(async (client) => send(res,
        result.status, result.status === 200
          ? { accountId: targetId, fullAccess: input.fullAccess,
            changed: result.changed }
          : { error: result.status === 404 ? "Аккаунт не найден"
            : "Уровень аккаунта изменился. Обновите список" }, guarded(client)));
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(error as Error); return true; }
      const known = error instanceof PlatformAccessBusy ||
        error instanceof PlatformAccessDenied || error instanceof RangeError ||
        error instanceof SyntaxError || error instanceof TypeError ||
        error instanceof URIError;
      if (!known) console.error(JSON.stringify({ event: "platform.tiers_failed",
        name: error instanceof Error ? error.name : undefined,
        code: (error as { code?: string } | null)?.code }));
      return send(res,
        error instanceof PlatformAccessBusy || (error as { code?: string } | null)?.code === "55P03" ? 409 :
        error instanceof PlatformAccessDenied ? 403 :
        error instanceof RangeError ? 413 : known ? 400 : 500,
        { error: known && error instanceof Error ? error.message
          : "Не удалось изменить уровень аккаунта" });
    }
  };
}
