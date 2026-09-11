import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { userStore } from "./users.ts";
import { ForbiddenError } from "./users.ts";
import type { settingsStore } from "./settings.ts";
import type { Role } from "../domain/access.ts";
import { isSameOriginRequest } from "./same-origin.ts";

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new RangeError("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function adminAccessHttp({
  auth,
  users,
  visibility,
  publicOrigin,
}: {
  auth: ReturnType<typeof createAuth>;
  users: ReturnType<typeof userStore>;
  visibility: ReturnType<typeof settingsStore>;
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
    if (
      path !== "/api/settings" &&
      path !== "/api/users" &&
      !path.startsWith("/api/users/")
    )
      return false;

    if (!auth.isAdmin(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error:
          path === "/api/settings"
            ? "Only administrators can change visibility"
            : "Only administrators can manage access",
      });

    if (path === "/api/users" && req.method === "GET")
      return json(res, 200, { users: users.list() });

    if (path.startsWith("/api/users/") && req.method === "PATCH") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        const body = await readJson(req);
        users.setRole(
          auth.currentUser(req)!,
          decodeURIComponent(path.slice("/api/users/".length)),
          body.role as Role,
        );
        return json(res, 200, { users: users.list() });
      } catch (error) {
        if (error instanceof RangeError)
          return json(res, 413, { error: error.message });
        return json(res, error instanceof ForbiddenError ? 403 : 400, {
          error: (error as Error).message,
        });
      }
    }

    if (path === "/api/settings" && req.method === "GET")
      return json(res, 200, visibility.read());

    if (path === "/api/settings" && req.method === "PUT") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        const body = await readJson(req);
        if (!auth.isAdmin(req))
          return json(res, 403, { error: "Access revoked" });
        return json(
          res,
          200,
          visibility.write(body, auth.currentUser(req)!),
        );
      } catch (error) {
        if (error instanceof RangeError)
          return json(res, 413, { error: error.message });
        return json(res, 400, { error: (error as Error).message });
      }
    }

    return json(res, 405, { error: "Method not allowed" });
  };
}
