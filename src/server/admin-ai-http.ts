import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { aiSettingsStore } from "./ai-settings.ts";
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

function environmentStatus(settings: ReturnType<typeof aiSettingsStore>) {
  const apiKeyConfigured = !!process.env.YANDEX_AI_API_KEY?.trim(),
    folderConfigured = !!process.env.YANDEX_AI_FOLDER_ID?.trim(),
    envModel = process.env.YANDEX_AI_MODEL?.trim() || "yandexgpt/rc",
    stored = settings.read().model,
    model = stored || envModel,
    enabled =
      apiKeyConfigured && (folderConfigured || model.startsWith("gpt://"));
  return {
    enabled,
    apiKeyConfigured,
    folderConfigured,
    model,
    modelOverride: stored,
    modelSource: stored ? "database" : process.env.YANDEX_AI_MODEL?.trim() ? "environment" : "default",
  };
}

export function adminAiHttp({
  auth,
  settings,
  publicOrigin,
}: {
  auth: ReturnType<typeof createAuth>;
  settings: ReturnType<typeof aiSettingsStore>;
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
    if (url.pathname !== "/api/admin/ai") return false;
    if (!auth.isAdmin(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "Only administrators can manage AI Studio",
      });

    if (req.method === "GET")
      return json(res, 200, environmentStatus(settings));

    if (req.method !== "PUT")
      return json(res, 405, { error: "Ожидается GET или PUT" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: "JSON required" });

    try {
      const body = await readJson(req);
      settings.write(body, auth.currentUser(req)!);
      return json(res, 200, environmentStatus(settings));
    } catch (error) {
      return json(res, error instanceof RangeError ? 413 : 400, {
        error: (error as Error).message,
      });
    }
  };
}
