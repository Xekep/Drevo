import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { researchCatalogStore } from "./research-catalog.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { PlatformAccessBusy, PlatformAccessDenied } from "./platform-access.ts";

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4096) throw new RangeError("Слишком большой запрос");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function adminResearchResourcesHttp({
  auth,
  catalog,
  publicOrigin,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  catalog: ReturnType<typeof researchCatalogStore>;
  publicOrigin?: string;
}) {
  const prefix = "/api/admin/research-resources";
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== prefix && !url.pathname.startsWith(`${prefix}/`))
      return false;
    const actor = await auth.currentUser(req);
    const session = await auth.accountSession(req);
    if ((!auth.local && !session) || !(await auth.isPlatformAdmin(req)))
      return json(res, session || actor ? 403 : 401, {
        error: "Только администратор платформы может управлять ресурсами",
      });
    if (url.pathname === prefix && req.method === "GET")
      return json(res, 200, { categories: await catalog.list() });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Недопустимый источник запроса" });
    if (
      req.method !== "DELETE" &&
      !req.headers["content-type"]?.startsWith("application/json")
    )
      return json(res, 415, { error: "Ожидается JSON" });

    try {
      const parts = url.pathname
        .slice(prefix.length)
        .split("/")
        .filter(Boolean);
      const body = req.method === "DELETE" ? undefined : await readJson(req);
      let categories;
      if (
        parts.length === 1 &&
        parts[0] === "categories" &&
        req.method === "POST"
      )
        categories = await catalog.createCategory(body, actor, session || undefined);
      else if (
        parts.length === 2 &&
        parts[0] === "categories" &&
        req.method === "PATCH"
      )
        categories = await catalog.updateCategory(
          decodeURIComponent(parts[1]),
          body,
          actor,
          session || undefined,
        );
      else if (
        parts.length === 2 &&
        parts[0] === "categories" &&
        req.method === "DELETE"
      )
        categories = await catalog.deleteCategory(
          decodeURIComponent(parts[1]),
          actor,
          session || undefined,
        );
      else if (
        parts.length === 3 &&
        parts[0] === "categories" &&
        parts[2] === "resources" &&
        req.method === "POST"
      )
        categories = await catalog.createResource(
          decodeURIComponent(parts[1]),
          body,
          actor,
          session || undefined,
        );
      else if (
        parts.length === 2 &&
        parts[0] === "resources" &&
        req.method === "PATCH"
      )
        categories = await catalog.updateResource(
          decodeURIComponent(parts[1]),
          body,
          actor,
          session || undefined,
        );
      else if (
        parts.length === 2 &&
        parts[0] === "resources" &&
        req.method === "DELETE"
      )
        categories = await catalog.deleteResource(
          decodeURIComponent(parts[1]),
          actor,
          session || undefined,
        );
      else return json(res, 404, { error: "Неизвестный запрос" });
      return json(res, req.method === "POST" ? 201 : 200, { categories });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Ошибка сохранения";
      if (error instanceof PlatformAccessDenied)
        return json(res, 403, { error: "Права администратора платформы отозваны" });
      if (error instanceof PlatformAccessBusy)
        return json(res, 409, { error: "Проверка прав занята. Повторите запрос" });
      if ((error as { code?: string }).code === "23505" || /UNIQUE constraint/iu.test(message))
        return json(res, 409, { error: "Такая категория или ссылка уже есть" });
      if (error instanceof RangeError || error instanceof SyntaxError)
        return json(res, 400, { error: message });
      console.error("platform_research_catalog_write_failed");
      return json(res, 500, { error: "Не удалось изменить каталог ресурсов" });
    }
  };
}
