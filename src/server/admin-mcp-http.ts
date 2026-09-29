import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { mcpTokenStore } from "./mcp-tokens.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import type { mcpUsageStore } from "./mcp-usage.ts";
import type { StoreDatabase } from "./store-database.ts";
import { accountAiAccess } from "./account-ai-access.ts";

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
    if (!(await auth.isAdmin(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: "Только администратор может управлять MCP-токенами",
      });
    if (!(await accountAiAccess(db, (await auth.currentUser(req))!.id, auth.local)))
      return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });

    if (path === "/api/mcp/tokens" && req.method === "GET") {
      const items = await Promise.all(
        (await tokens.list()).map(async (token) => ({
          ...token,
          usage: await usage.tokenSummary(token.id),
        })),
      );
      return json(res, 200, {
        tokens: items,
        bindings: await tokens.bindingOptions(),
        recentUsage: await usage.recent(),
      });
    }

    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });

    if (path === "/api/mcp/tokens" && req.method === "POST") {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        return json(
          res,
          201,
          await tokens.issue(
            (await auth.currentUser(req))!,
            await readJson(req),
          ),
        );
      } catch (error) {
        return json(res, error instanceof RangeError ? 413 : 400, {
          error: (error as Error).message,
        });
      }
    }

    if (path.startsWith("/api/mcp/tokens/") && req.method === "DELETE") {
      try {
        await tokens.revoke(
          decodeURIComponent(path.slice("/api/mcp/tokens/".length)),
        );
        return json(res, 200, { revoked: true });
      } catch (error) {
        return json(res, 400, { error: (error as Error).message });
      }
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return json(res, 405, { error: "Method not allowed" });
  };
}
