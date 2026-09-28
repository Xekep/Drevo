import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { vkAuthSettingsStore } from "./vk-auth-settings.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { ForbiddenError } from "./users.ts";

export function adminVkAuthHttp(
  auth: Awaited<ReturnType<typeof createAuth>>,
  settings: ReturnType<typeof vkAuthSettingsStore>,
  publicOrigin?: string,
) {
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/admin/auth/vk") return false;
    const json = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
      return true;
    };
    if (!(await auth.isAdmin(req)))
      return json((await auth.currentUser(req)) ? 403 : 401, {
        error: "Настройки входа доступны только администратору",
      });
    if (req.method === "GET") return json(200, await settings.read());
    if (req.method !== "PUT")
      return json(405, { error: "Метод не поддерживается" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(403, { error: "Invalid origin" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(415, { error: "JSON required" });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 4096) return json(413, { error: "Слишком большой запрос" });
        chunks.push(Buffer.from(chunk));
      }
      return json(
        200,
        await settings.write(
          JSON.parse(Buffer.concat(chunks).toString("utf8")),
          (await auth.currentUser(req))!,
        ),
      );
    } catch (error) {
      return json(error instanceof ForbiddenError ? 403 : 400, {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось сохранить настройки",
      });
    }
  };
}
