import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { userStore } from "./users.ts";
import { ForbiddenError } from "./users.ts";
import type { settingsStore } from "./settings.ts";
import type { Role, TreeAccess } from "../domain/access.ts";
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
  auth: Awaited<ReturnType<typeof createAuth>>;
  users: Awaited<ReturnType<typeof userStore>>;
  visibility: Awaited<ReturnType<typeof settingsStore>>;
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

    if (!(await auth.isAdmin(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
        error:
          path === "/api/settings"
            ? "Only administrators can change visibility"
            : "Only administrators can manage access",
      });

    if (path === "/api/users" && req.method === "GET") {
      try {
        const rawLimit = url.searchParams.get("limit") || "20";
        const limit = Number(rawLimit);
        const cursor = url.searchParams.get("cursor") || undefined;
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 50 ||
          (cursor && cursor.length > 512)
        )
          throw new Error("Некорректный размер страницы участников");
        return json(res, 200, await users.listPage(limit, cursor));
      } catch (error) {
        return json(res, 400, { error: (error as Error).message });
      }
    }

    if (path.startsWith("/api/users/") && req.method === "PATCH") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        const body = await readJson(req);
        const id = decodeURIComponent(path.slice("/api/users/".length));
        const identity =
          body.personId !== undefined || body.treeAccess !== undefined;
        if (
          (body.approved !== undefined && typeof body.approved !== "boolean") ||
          Number(body.approved !== undefined) +
            Number(body.role !== undefined) +
            Number(identity) !==
            1
        )
          throw new Error("Изменяйте допуск, роль или привязку отдельно");
        if (typeof body.approved === "boolean")
          await users.setApproved(
            (await auth.currentUser(req))!,
            id,
            body.approved,
          );
        if (body.role !== undefined)
          await users.setRole(
            (await auth.currentUser(req))!,
            id,
            body.role as Role,
          );
        if (identity) {
          const target = await users.get(id);
          if (!target) throw new Error("Пользователь не найден");
          await users.setIdentity(
            (await auth.currentUser(req))!,
            id,
            body.personId === undefined
              ? target.personId || null
              : body.personId,
            body.treeAccess === undefined
              ? target.treeAccess || "all"
              : (body.treeAccess as TreeAccess),
          );
        }
        return json(res, 200, { user: await users.get(id) });
      } catch (error) {
        if (error instanceof RangeError)
          return json(res, 413, { error: error.message });
        return json(res, error instanceof ForbiddenError ? 403 : 400, {
          error: (error as Error).message,
        });
      }
    }

    if (path.startsWith("/api/users/") && req.method === "DELETE") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      try {
        await users.remove(
          (await auth.currentUser(req))!,
          decodeURIComponent(path.slice("/api/users/".length)),
        );
        return json(res, 200, { deleted: true });
      } catch (error) {
        return json(res, error instanceof ForbiddenError ? 403 : 400, {
          error: (error as Error).message,
        });
      }
    }

    if (path === "/api/settings" && req.method === "GET")
      return json(res, 200, await visibility.read());

    if (path === "/api/settings" && req.method === "PUT") {
      if (!isSameOriginRequest(req, publicOrigin))
        return json(res, 403, { error: "Invalid origin" });
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        const body = await readJson(req);
        if (!(await auth.isAdmin(req)))
          return json(res, 403, { error: "Access revoked" });
        return json(
          res,
          200,
          await visibility.write(body, (await auth.currentUser(req))!),
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
