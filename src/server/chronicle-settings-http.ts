import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import {
  chronicleSettingsStore,
  ChronicleSettingsConflict,
} from "./chronicle-settings.ts";
import type { StoreDatabase } from "./store-database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { PlatformAccessBusy, PlatformAccessDenied } from "./platform-access.ts";

export function chronicleSettingsHttp({
  auth,
  db,
  publicOrigin,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  publicOrigin?: string;
}) {
  const store = chronicleSettingsStore(db);
  return async (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname !== "/api/chronicle-settings") return false;
    const json = (status: number, data: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "private, no-store",
      });
      res.end(JSON.stringify(data));
      return true;
    };
    if (!(await auth.canRead(req)))
      return json(401, { error: "Нужен доступ к архиву" });
    const canConfigure = await auth.isPlatformAdmin(req);
    if (req.method === "GET")
      return json(200, { ...(await store.read()), canConfigure });
    if (req.method !== "PUT")
      return json(405, { error: "Метод не поддерживается" });
    if (!canConfigure)
      return json(403, {
        error:
          "Настройки общие для всех древ. Нужны права администратора платформы",
      });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(403, { error: "Недопустимый источник запроса" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(415, { error: "Ожидается JSON" });
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) throw new RangeError("Слишком большой запрос");
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Object.keys(body).some((key) => !["settings", "version"].includes(key))
      )
        throw new RangeError("Некорректный запрос");
      if (!(await auth.isPlatformAdmin(req)))
        throw new PlatformAccessDenied("Права отозваны");
      const saved = await store.save(
        body.settings,
        body.version,
        await auth.currentUser(req),
        (await auth.accountSession(req)) || undefined,
      );
      return json(200, { ...saved, canConfigure: true });
    } catch (error) {
      if (error instanceof PlatformAccessDenied)
        return json(403, { error: "Права администратора платформы отозваны" });
      if (
        error instanceof PlatformAccessBusy ||
        error instanceof ChronicleSettingsConflict
      )
        return json(409, { error: error.message });
      if (error instanceof RangeError || error instanceof SyntaxError)
        return json(400, { error: error.message });
      throw error;
    }
  };
}
