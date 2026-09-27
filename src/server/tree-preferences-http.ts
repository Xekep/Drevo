import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { treePreferencesStore } from "./tree-preferences.ts";
import { isSameOriginRequest } from "./same-origin.ts";

export function treePreferencesHttp({
  auth,
  preferences,
  publicOrigin,
}: {
  auth: ReturnType<typeof createAuth>;
  preferences: ReturnType<typeof treePreferencesStore>;
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
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/tree-preferences") return false;
    const user = auth.currentUser(req);
    if (!user?.approved)
      return json(res, user ? 403 : 401, { error: "Войдите в архив" });
    if (req.method === "GET") return json(res, 200, preferences.read(user.id));
    if (req.method !== "PUT")
      return json(res, 405, { error: "Method not allowed" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: "JSON required" });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1024)
          return json(res, 413, { error: "Слишком большой запрос" });
        chunks.push(Buffer.from(chunk));
      }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!auth.currentUser(req)?.approved)
        return json(res, 403, { error: "Доступ отозван" });
      return json(res, 200, preferences.write(user.id, value));
    } catch (error) {
      return json(res, 400, { error: (error as Error).message });
    }
  };
}
