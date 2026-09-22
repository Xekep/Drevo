import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import {
  aiRuntimeConfig,
  publicAiStatus,
  type aiSettingsStore,
} from "./ai-settings.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import type { aiUsageStore } from "./ai-usage.ts";

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

type AiTestResponse = {
  choices?: Array<{ message?: { content?: string | null } }>;
  error?: { message?: string };
};

export function adminAiHttp({
  auth,
  settings,
  usage,
  publicOrigin,
  fetcher = fetch,
}: {
  auth: ReturnType<typeof createAuth>;
  settings: ReturnType<typeof aiSettingsStore>;
  usage: ReturnType<typeof aiUsageStore>;
  publicOrigin?: string;
  fetcher?: typeof fetch;
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
    if (path !== "/api/admin/ai" && path !== "/api/admin/ai/test")
      return false;
    if (!auth.isAdmin(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "Только администратор может управлять AI Studio",
      });

    if (path === "/api/admin/ai" && req.method === "GET")
      return json(res, 200, {
        ...publicAiStatus(settings),
        usage: usage.summary(),
      });

    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });

    if (path === "/api/admin/ai" && req.method === "PUT") {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        settings.write(await readJson(req), auth.currentUser(req)!);
        return json(res, 200, {
          ...publicAiStatus(settings),
          usage: usage.summary(),
        });
      } catch (error) {
        return json(res, error instanceof RangeError ? 413 : 400, {
          error: (error as Error).message,
        });
      }
    }

    if (path === "/api/admin/ai/test" && req.method === "POST") {
      const runtime = aiRuntimeConfig(settings);
      if (!runtime.configured)
        return json(res, 400, {
          error:
            "AI Studio не настроена: проверьте YANDEX_AI_API_KEY, YANDEX_AI_FOLDER_ID или полный gpt:// URI модели",
        });
      try {
        const response = await fetcher(`${runtime.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              Authorization: `Api-Key ${runtime.apiKey}`,
              "Content-Type": "application/json",
              ...(runtime.folderId
                ? { "OpenAI-Project": runtime.folderId }
                : {}),
            },
            body: JSON.stringify({
              model: runtime.modelUri,
              messages: [
                {
                  role: "user",
                  content:
                    "Это проверка подключения Drevo. Ответь одним словом: OK",
                },
              ],
              temperature: 0,
            }),
          }),
          data = (await response.json()) as AiTestResponse;
        if (!response.ok)
          return json(res, 502, {
            error:
              data.error?.message ||
              `AI Studio вернула HTTP ${response.status}`,
          });
        return json(res, 200, {
          ok: true,
          model: runtime.model,
          answer:
            data.choices?.[0]?.message?.content?.trim() ||
            "Подключение установлено",
        });
      } catch (error) {
        return json(res, 502, {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось проверить подключение AI Studio",
        });
      }
    }

    res.setHeader("Allow", "GET, PUT, POST");
    return json(res, 405, { error: "Method not allowed" });
  };
}
