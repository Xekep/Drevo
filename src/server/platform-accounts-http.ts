import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { StoreDatabase } from "./store-database.ts";
import type { createAuth } from "./auth.ts";
import type { PlatformAccount } from "../shared/platform-accounts.ts";
import { assertCurrentPlatformAdmin, PlatformAccessBusy, PlatformAccessDenied } from "./platform-access.ts";

const PAGE_SIZE = 30;
const encodeCursor = (name: string, id: string) => Buffer.from(JSON.stringify([name, id])).toString("base64url");
function decodeCursor(value: string) {
  if (!value) return null;
  if (value.length > 1600 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TypeError("Некорректная страница.");
  try {
    const data: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!Array.isArray(data) || data.length !== 2 || typeof data[0] !== "string" ||
        typeof data[1] !== "string" || data[0].length > 320 || !data[1] || data[1].length > 200) throw new Error();
    return data as [string, string];
  } catch { throw new TypeError("Некорректная страница."); }
}

/** One bounded directory; mutations keep their existing role/tier contracts. */
export function platformAccountsHttp(db: StoreDatabase, auth: Awaited<ReturnType<typeof createAuth>>,
  beforeDelivery?: () => Promise<void>) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    const statistics = url.pathname === "/api/platform/accounts/statistics";
    if (!statistics && url.pathname !== "/api/platform/accounts") return false;
    const send = async (status: number, body: unknown, timeout = 0) => {
      const timer = timeout ? setTimeout(() => res.destroy(new Error("Platform directory delivery timed out")), timeout) : null;
      timer?.unref();
      try {
        const complete = timeout ? finished(res, { cleanup: true }) : null;
        res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
        if (complete) await complete;
      } finally { if (timer) clearTimeout(timer); }
      return true;
    };
    if (db.kind !== "postgres" || !db.postgresTransaction) return send(501, { error: "Список аккаунтов доступен с PostgreSQL." });
    const session = await auth.accountSession(req);
    if (!session) return send(401, { error: "Сеанс завершён." });
    if (req.method !== "GET") return send(405, { error: "Метод не поддерживается." });
    try {
      const query = (url.searchParams.get("q") || "").trim().replace(/\s+/g, " ");
      if (query.length > 160) throw new TypeError("Поиск ограничен 160 символами.");
      const after = decodeCursor(url.searchParams.get("after") || "");
      return await db.postgresTransaction(async (client) => {
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        await client.query("SET LOCAL statement_timeout='3s'");
        let body: unknown;
        if (statistics) {
          const result = await client.query(`SELECT count(*)::int AS accounts,
            count(*) FILTER (WHERE NOT coalesce(t.full_access,false))::int AS basic,
            count(*) FILTER (WHERE t.full_access)::int AS full,
            count(*) FILTER (WHERE pa.account_id IS NOT NULL)::int AS admins,
            count(*) FILTER (WHERE pa.account_id IS NULL AND pr.account_id IS NOT NULL)::int AS researchers
            FROM accounts a LEFT JOIN account_tiers t ON t.account_id=a.id
            LEFT JOIN platform_admins pa ON pa.account_id=a.id
            LEFT JOIN platform_researchers pr ON pr.account_id=a.id`);
          body = result.rows[0];
        } else {
          // Escape LIKE metacharacters: an entered '%' or '_' is literal text.
          const pattern = `%${query.toLocaleLowerCase("ru").replaceAll("ё", "е").replace(/[\\%_]/g, "\\$&")}%`;
          const result = await client.query<{ id: string; name: string; role: PlatformAccount["role"];
            full_access: boolean; last_visit_at: string | null; sort_name: string }>(
            `SELECT a.id,a.name,a.last_visit_at,coalesce(t.full_access,false) AS full_access,
              lower(a.name) AS sort_name,
              CASE WHEN pa.account_id IS NOT NULL THEN 'admin'
                   WHEN pr.account_id IS NOT NULL THEN 'researcher' ELSE NULL END AS role
             FROM accounts a LEFT JOIN account_tiers t ON t.account_id=a.id
             LEFT JOIN platform_admins pa ON pa.account_id=a.id
             LEFT JOIN platform_researchers pr ON pr.account_id=a.id
             WHERE ($1='' OR replace(lower(a.name),'ё','е') LIKE $2 ESCAPE '\\' OR lower(a.id) LIKE $2 ESCAPE '\\')
               AND ($3::text IS NULL OR (lower(a.name) COLLATE "C",a.id COLLATE "C") > ($3 COLLATE "C",$4 COLLATE "C"))
             ORDER BY lower(a.name) COLLATE "C",a.id COLLATE "C" LIMIT $5`,
            [query, pattern, after?.[0] ?? null, after?.[1] ?? "", PAGE_SIZE + 1]);
          const page = result.rows.slice(0, PAGE_SIZE);
          body = { accounts: page.map((row) => ({ id: row.id, name: row.name, role: row.role,
            fullAccess: row.full_access, lastVisitAt: row.last_visit_at })),
            next: result.rows.length > PAGE_SIZE ? encodeCursor(page.at(-1)!.sort_name, page.at(-1)!.id) : null };
        }
        await beforeDelivery?.();
        // Recheck after searching/counting and retain permission locks through
        // delivery, bounded by the remaining session lifetime.
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        const active = await client.query<{ expires_at: string }>(
          "SELECT expires_at FROM account_sessions WHERE token_hash=$1 AND user_id=$2", [session.tokenHash, session.accountId]);
        const timeout = Math.min(4000, Number(active.rows[0]?.expires_at) - Date.now());
        if (!(timeout > 0)) throw new PlatformAccessDenied();
        return send(200, body, timeout);
      });
    } catch (error) {
      if (res.headersSent || res.destroyed) { res.destroy(); return true; }
      return send(error instanceof PlatformAccessBusy ? 409 : error instanceof PlatformAccessDenied ? 403 :
        error instanceof TypeError ? 400 : 500, { error: error instanceof TypeError ? error.message :
          error instanceof PlatformAccessBusy ? "Проверка прав занята. Повторите запрос." :
            error instanceof PlatformAccessDenied ? "Нет доступа к аккаунтам платформы." : "Не удалось загрузить аккаунты." });
    }
  };
}
