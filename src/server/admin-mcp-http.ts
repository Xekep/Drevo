import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { mcpTokenStore } from "./mcp-tokens.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import type { mcpUsageStore } from "./mcp-usage.ts";
import type { StoreDatabase } from "./store-database.ts";
import { accountAiAccess } from "./account-ai-access.ts";
import { finished } from "node:stream/promises";
import { isArchiveOwner } from "../domain/access.ts";
import {
  assertPlatformAdminInArchiveTransaction,
  PlatformAccessBusy,
  PlatformAccessDenied,
} from "./platform-access.ts";

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new RangeError("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function adminMcpHttp({
  auth,
  db,
  tokens,
  usage,
  publicOrigin,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  tokens: ReturnType<typeof mcpTokenStore>;
  usage: ReturnType<typeof mcpUsageStore>;
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

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname;
    if (path !== "/api/mcp/tokens" && !path.startsWith("/api/mcp/tokens/"))
      return false;
    const actor = await auth.currentUser(req);
    if (!actor || !actor.approved || !isArchiveOwner(actor) || !(await auth.isPlatformAdmin(req)))
      return json(res, (await auth.accountId(req)) ? 403 : 401, {
        error: "Только администратор может управлять MCP-токенами",
      });
    // MCP bearer tokens remain scoped to this archive. Platform staff without
    // its own approved membership cannot mint a private-tree credential.
    const session = auth.local ? null : await auth.accountSession(req);
    if (!auth.local && !session)
      return json(res, 401, { error: "Сеанс завершён" });
    if (!(await accountAiAccess(db, actor.id, auth.local)))
      return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });

    const withAccess = async <T>(work: () => Promise<T>): Promise<T> =>
      db.transaction(async () => {
        if (!auth.local) {
          await assertPlatformAdminInArchiveTransaction(db, session!.accountId, session!.tokenHash);
          const member = await db.prepare("", `SELECT role,approved,person_id,tree_access
            FROM archive_memberships WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`)
            .get(db.archiveId || "", actor.id);
          if (!member?.approved || member.role !== actor.role ||
              (member.person_id || "") !== (actor.personId || "") ||
              member.tree_access !== (actor.treeAccess || "all"))
            throw new PlatformAccessDenied("Членство в архиве изменилось");
          const owner = await db.prepare("", `SELECT user_id FROM archive_owners
            WHERE archive_id=? AND user_id=? FOR SHARE NOWAIT`)
            .get(db.archiveId || "", actor.id);
          if (!owner) throw new PlatformAccessDenied("Владение архивом изменилось");
        }
        if (!(await accountAiAccess(db, actor.id, auth.local, true)))
          throw new PlatformAccessDenied("ИИ-функции недоступны этому аккаунту");
        return work();
      });

    const guardedJson = async (status: number, value: unknown) => {
      const timer = setTimeout(() => res.destroy(new Error("MCP admin delivery timed out")), 4_000);
      timer.unref();
      try {
        const done = finished(res, { cleanup: true });
        json(res, status, value);
        await done;
      } finally {
        clearTimeout(timer);
      }
      return true;
    };

    if (path === "/api/mcp/tokens" && req.method === "GET") {
      const items = await Promise.all(
        (await tokens.list()).map(async (token) => ({
          ...token,
          usage: await usage.tokenSummary(token.id),
        })),
      );
      const value = { tokens: items,
        bindings: await tokens.bindingOptions(), recentUsage: await usage.recent() };
      try {
        return await withAccess(() => guardedJson(200, value));
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(error as Error); return true; }
        return json(res, error instanceof PlatformAccessBusy ? 409 : 403,
          { error: "Доступ к MCP-токенам изменился. Повторите запрос" });
      }
    }

    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });

    if (path === "/api/mcp/tokens" && req.method === "POST") {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        const body = await readJson(req);
        return await withAccess(async () =>
          guardedJson(201, await tokens.issue(actor, body)));
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(error as Error); return true; }
        if (error instanceof PlatformAccessBusy || error instanceof PlatformAccessDenied)
          return json(res, error instanceof PlatformAccessBusy ? 409 : 403,
            { error: "Доступ к MCP-токенам изменился. Повторите запрос" });
        return json(res, error instanceof RangeError ? 413 : 400, {
          error: (error as Error).message,
        });
      }
    }

    if (path.startsWith("/api/mcp/tokens/") && req.method === "DELETE") {
      try {
        return await withAccess(async () => {
          await tokens.revoke(decodeURIComponent(path.slice("/api/mcp/tokens/".length)));
          return guardedJson(200, { revoked: true });
        });
      } catch (error) {
        if (res.headersSent || res.destroyed) { res.destroy(error as Error); return true; }
        if (error instanceof PlatformAccessBusy || error instanceof PlatformAccessDenied)
          return json(res, error instanceof PlatformAccessBusy ? 409 : 403,
            { error: "Доступ к MCP-токенам изменился. Повторите запрос" });
        return json(res, 400, { error: (error as Error).message });
      }
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: "Method not allowed" });
  };
}
