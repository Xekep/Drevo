import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";

export function coreHttp({
  archive,
  auth,
  publicOrigin,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
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
    if (path === "/api/health" && req.method === "GET")
      return json(res, 200, { ok: true, revision: archive.meta().revision });

    if (path === "/api/login")
      return json(res, 404, { error: "Password sign-in has been removed" });

    if (path === "/auth/logout" && req.method === "POST") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      auth.logout(req, res);
      return json(res, 200, { ok: true });
    }

    return false;
  };
}
