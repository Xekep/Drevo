import type { IncomingMessage, ServerResponse } from "node:http";
import { finished } from "node:stream/promises";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { accountCapacity } from "./account-capacity.ts";

export function coreHttp({
  archive,
  auth,
  publicOrigin,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  publicOrigin?: string;
}) {
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };
  const signInRequired = (res: ServerResponse) =>
    json(res, 401, { error: "Требуется вход" });
  async function accountRead(
    req: IncomingMessage,
    res: ServerResponse,
    value: unknown,
    expectedAccountId?: string,
    requireOwner = false,
  ) {
    if (auth.local) return json(res, 200, value);
    const session = await auth.accountSession(req);
    if (!session || (expectedAccountId && session.accountId !== expectedAccountId))
      return signInRequired(res);
    if (archive.db.kind !== "postgres") return json(res, 200, value);
    if (!archive.db.postgresTransaction)
      throw new Error("PostgreSQL account response requires a transaction");
    const archiveId = archive.db.archiveId;
    if (requireOwner && !archiveId)
      throw new Error("PostgreSQL account capacity requires an archive ID");
    try {
      return await archive.db.postgresTransaction(async (client) => {
        await client.query("SET LOCAL lock_timeout='5s'");
        // Owner-transfer writes lock the archive before the session and owner.
        // Keep the same order so a prepared owned capacity cannot outlive a
        // completed transfer, without cross-locking those transactions.
        const currentArchive = requireOwner
          ? await client.query("SELECT id FROM archives WHERE id=$1 FOR SHARE", [archiveId])
          : null;
        const locked = await client.query<{ expires_at: string }>(
          `SELECT expires_at FROM account_sessions
            WHERE token_hash=$1 AND user_id=$2 FOR SHARE`,
          [session.tokenHash, session.accountId],
        );
        if (!locked.rows[0] || Number(locked.rows[0].expires_at) <= Date.now())
          return signInRequired(res);
        if (requireOwner) {
          const owner = currentArchive?.rowCount
            ? await client.query(
                `SELECT 1 FROM archive_owners
                  WHERE archive_id=$1 AND user_id=$2 FOR SHARE`,
                [archiveId, session.accountId],
              )
            : null;
          if (!owner?.rowCount)
            return json(res, 409, { error: "Владелец архива изменился. Обновите страницу." });
        }
        // Keep the session row locked until the response is handed to HTTP.
        // A concurrent revoke must complete before this check or wait here.
        const delivered = finished(res, { cleanup: true });
        const timeout = setTimeout(() => res.destroy(), 5_000);
        timeout.unref();
        try {
          json(res, 200, value);
          await delivered;
        } catch {
          res.destroy();
          await delivered.catch(() => {});
        } finally {
          clearTimeout(timeout);
        }
        return true;
      });
    } catch (error) {
      if (res.headersSent || res.destroyed) {
        res.destroy();
        return true;
      }
      if ((error as { code?: string }).code === "55P03")
        return json(res, 503, { error: "Повторите запрос позже" });
      throw error;
    }
  }

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname;
    if (path === "/api/health" && req.method === "GET")
      return json(res, 200, {
        ok: true,
        revision: (await archive.meta()).revision,
      });

    if (path === "/api/login")
      return json(res, 404, { error: "Password sign-in has been removed" });

    if (path === "/api/account/sessions" && req.method === "GET") {
      const sessions = await auth.sessionSummary(req);
      return sessions
        ? accountRead(req, res, sessions)
        : signInRequired(res);
    }

    if (path === "/api/account/capacity" && req.method === "GET") {
      const user = await auth.currentUser(req);
      if (!user) return signInRequired(res);
      const capacity = await accountCapacity(archive.db, user.id);
      return accountRead(req, res, capacity, user.id,
        capacity.available && capacity.owned);
    }

    if (
      path === "/api/account/sessions/revoke-others" &&
      req.method === "POST"
    ) {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      const revoked = await auth.revokeOtherSessions(req);
      return revoked === null
        ? json(res, 401, { error: "Требуется вход" })
        : json(res, 200, { revoked });
    }

    const managedSession = path.match(
      /^\/api\/account\/sessions\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/revoke$/i,
    );
    if (managedSession && req.method === "POST") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      const revoked = await auth.revokeManagedSession(
        req,
        managedSession[1].toLowerCase(),
      );
      if (revoked === null) return json(res, 401, { error: "Требуется вход" });
      if (revoked === "current")
        return json(res, 409, {
          error: "Для выхода из текущего сеанса используйте кнопку «Выйти».",
        });
      return json(res, 200, { revoked });
    }

    if (path === "/auth/logout" && req.method === "POST") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      await auth.logout(req, res);
      return json(res, 200, { ok: true });
    }

    return false;
  };
}
