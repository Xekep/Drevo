import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { StoreDatabase } from "./store-database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import {
  assertCurrentPlatformAdmin,
  PlatformAccessBusy,
  PlatformAccessDenied,
} from "./platform-access.ts";

type GlobalRole = "admin" | "researcher" | null;
const PAGE_SIZE = 30;
const ROLE_LOCK = 190741602;

async function readRole(req: IncomingMessage): Promise<GlobalRole> {
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
      !Object.hasOwn(body, "role"))
    throw new TypeError("Укажите глобальную роль");
  const role = (body as { role: unknown }).role;
  if (role !== null && role !== "admin" && role !== "researcher")
    throw new TypeError("Неизвестная глобальная роль");
  return role;
}

/** Platform roles belong to accounts, never to an archive membership. */
export function platformRolesHttp(
  db: StoreDatabase,
  auth: Awaited<ReturnType<typeof createAuth>>,
  publicOrigin?: string,
) {
  const send = async (res: ServerResponse, status: number, value: unknown, bounded = false) => {
    const timer = bounded
      ? setTimeout(() => res.destroy(new Error("Platform roles delivery timed out")), 4_000)
      : null;
    timer?.unref();
    try {
      const done = bounded ? finished(res, { cleanup: true }) : null;
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end(JSON.stringify(value));
      if (done) await done;
    } finally {
      if (timer) clearTimeout(timer);
    }
    return true;
  };
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/platform/roles" &&
        !/^\/api\/platform\/roles\/[^/]+$/.test(url.pathname)) return false;
    if (db.kind !== "postgres" || !db.postgresTransaction)
      return send(res, 501, { error: "Глобальные роли доступны с PostgreSQL" });
    const session = await auth.accountSession(req);
    if (!session) return send(res, 401, { error: "Сеанс завершён" });
    try {
      if (url.pathname === "/api/platform/roles" && req.method === "GET") {
        const after = url.searchParams.get("after") || "";
        if (after.length > 200)
          return send(res, 400, { error: "Некорректная страница" });
        return await db.postgresTransaction(async (client) => {
          await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
          const rows = await client.query<{
            id: string; name: string; role: GlobalRole;
          }>(`SELECT a.id,a.name,
              CASE WHEN pa.account_id IS NOT NULL THEN 'admin'
                   WHEN pr.account_id IS NOT NULL THEN 'researcher'
                   ELSE NULL END AS role
             FROM accounts a
             LEFT JOIN platform_admins pa ON pa.account_id=a.id
             LEFT JOIN platform_researchers pr ON pr.account_id=a.id
             WHERE a.id COLLATE "C" > $1 COLLATE "C"
             ORDER BY a.id COLLATE "C" LIMIT $2`, [after, PAGE_SIZE + 1]);
          const items = rows.rows.slice(0, PAGE_SIZE);
          return send(res, 200, {
            accounts: items,
            next: rows.rows.length > PAGE_SIZE ? items.at(-1)?.id : null,
          }, true);
        });
      }
      const targetId = url.pathname.startsWith("/api/platform/roles/")
        ? decodeURIComponent(url.pathname.slice("/api/platform/roles/".length))
        : "";
      if (req.method !== "PATCH" || !targetId)
        return send(res, 405, { error: "Метод не поддерживается" });
      if (targetId.length > 200)
        return send(res, 400, { error: "Некорректный аккаунт" });
      if (!isSameOriginRequest(req, publicOrigin))
        return send(res, 403, { error: "Недопустимый источник запроса" });
      const role = await readRole(req);
      const result = await db.postgresTransaction(async (client) => {
        // Serialize the last-admin invariant before locking either actor or
        // target account. NOWAIT avoids cross-account role-change deadlocks.
        const gate = await client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_xact_lock($1) AS locked", [ROLE_LOCK]);
        if (!gate.rows[0]?.locked) throw new PlatformAccessBusy("Глобальные роли заняты");
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        let target;
        try {
          target = await client.query("SELECT id FROM accounts WHERE id=$1 FOR UPDATE NOWAIT", [targetId]);
        } catch (error) {
          if ((error as { code?: string }).code === "55P03")
            throw new PlatformAccessBusy("Аккаунт занят другим действием");
          throw error;
        }
        if (!target.rowCount) return null;
        const [admin, researcher] = await Promise.all([
          client.query("SELECT account_id FROM platform_admins WHERE account_id=$1 FOR UPDATE", [targetId]),
          client.query("SELECT account_id FROM platform_researchers WHERE account_id=$1 FOR UPDATE", [targetId]),
        ]);
        const before: GlobalRole = admin.rowCount ? "admin" : researcher.rowCount ? "researcher" : null;
        if (before === role) return { role, changed: false };
        if (before === "admin") {
          const remaining = await client.query<{ n: string }>(
            "SELECT count(*) AS n FROM platform_admins");
          if (Number(remaining.rows[0]?.n) <= 1)
            throw new PlatformAccessDenied("Нельзя снять роль последнего администратора платформы");
        }
        await client.query("DELETE FROM platform_admins WHERE account_id=$1", [targetId]);
        await client.query("DELETE FROM platform_researchers WHERE account_id=$1", [targetId]);
        if (role === "admin")
          await client.query("INSERT INTO platform_admins(account_id) VALUES($1)", [targetId]);
        if (role === "researcher")
          await client.query("INSERT INTO platform_researchers(account_id) VALUES($1)", [targetId]);
        await client.query(`INSERT INTO platform_role_audit(actor_id,target_id,old_role,new_role)
          VALUES($1,$2,$3,$4)`, [session.accountId, targetId, before, role]);
        return { role, changed: true };
      });
      return result
        ? send(res, 200, { accountId: targetId, ...result })
        : send(res, 404, { error: "Аккаунт не найден" });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy(error as Error);
        return true;
      }
      const known = error instanceof PlatformAccessBusy ||
        error instanceof PlatformAccessDenied || error instanceof RangeError ||
        error instanceof SyntaxError || error instanceof TypeError ||
        error instanceof URIError;
      if (!known) console.error(JSON.stringify({ event: "platform.roles_failed",
        name: error instanceof Error ? error.name : undefined,
        code: (error as { code?: string } | null)?.code }));
      return send(res,
        error instanceof PlatformAccessBusy ? 409 :
        error instanceof PlatformAccessDenied ? 403 :
        error instanceof RangeError ? 413 : known ? 400 : 500,
        { error: known && error instanceof Error
          ? error.message : "Не удалось изменить глобальные роли" });
    }
  };
}
