import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import {
  aiRuntimeConfig,
  publicAiStatus,
  type aiSettingsStore,
} from "./ai-settings.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import type { aiUsageStore } from "./ai-usage.ts";
import { fetchAiStudioModels, type AiStudioModel } from "./ai-models.ts";
import { yandexResponsesClient } from "./yandex-responses.ts";
import { ROLE_NAMES, type Role } from "../domain/access.ts";
import type { StoreDatabase } from "./store-database.ts";
import { accountAiAccess } from "./account-ai-access.ts";

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw new RangeError("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function adminAiHttp({
  auth,
  db,
  settings,
  usage,
  publicOrigin,
  fetcher = fetch,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  settings: Awaited<ReturnType<typeof aiSettingsStore>>;
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
  const statusValue = async () => {
    const runtime = await aiRuntimeConfig(settings);
    let models: AiStudioModel[] = [];
    let modelsError = "";
    if (runtime.apiKey && runtime.folderId)
      try {
        models = await fetchAiStudioModels({
          baseUrl: runtime.baseUrl,
          apiKey: runtime.apiKey,
          folderId: runtime.folderId,
          fetcher,
        });
      } catch (error) {
        modelsError =
          error instanceof Error
            ? error.message
            : "Не удалось получить список моделей AI Studio";
      }
    return {
      ...(await publicAiStatus(settings)),
      models,
      modelsError,
      usage: await usage.summary(),
    };
  };

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname;
    if (
      path !== "/api/admin/ai" &&
      path !== "/api/admin/ai/test" &&
      path !== "/api/admin/ai/models"
    )
      return false;
    if (!(await auth.isAdmin(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: "Только администратор может управлять AI Studio",
      });
    const adminId = (await auth.currentUser(req))!.id;
    if (!(await accountAiAccess(db, adminId, auth.local)))
      return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });

    if (path === "/api/admin/ai" && req.method === "GET") {
      const status = await statusValue();
      if (!(await auth.isAdmin(req)) ||
        !(await accountAiAccess(db, adminId, auth.local)))
        return json(res, 403, { error: "Доступ отозван" });
      return json(res, 200, status);
    }

    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });

    if (path === "/api/admin/ai" && req.method === "PUT") {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        const body = await readJson(req);
        if (!(await auth.isAdmin(req)))
          return json(res, 403, { error: "Доступ отозван" });
        const written = await db.transaction(async () => {
          const current = await auth.currentUser(req);
          if (!current || current.id !== adminId ||
            !(await auth.isAdmin(req)) ||
            !(await accountAiAccess(db, adminId, auth.local, true))) return false;
          await settings.write(body, current);
          return true;
        });
        if (!written) return json(res, 403, { error: "Доступ отозван" });
        if (!(await accountAiAccess(db, adminId, auth.local)))
          return json(res, 403, { error: "Доступ отозван" });
        const status = await statusValue();
        if (!(await auth.isAdmin(req)) ||
          !(await accountAiAccess(db, adminId, auth.local)))
          return json(res, 403, { error: "Доступ отозван" });
        return json(res, 200, status);
      } catch (error) {
        return json(res, error instanceof RangeError ? 413 : 400, {
          error: (error as Error).message,
        });
      }
    }

    if (path === "/api/admin/ai/models" && req.method === "POST") {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        const body = (await readJson(req)) as Record<string, unknown>,
          runtime = await aiRuntimeConfig(settings),
          folderId =
            typeof body.folderId === "string" ? body.folderId.trim() : "",
          submittedApiKey =
            typeof body.apiKey === "string" ? body.apiKey.trim() : "",
          apiKey = submittedApiKey || runtime.apiKey;
        if (!folderId || !/^[a-zA-Z0-9_-]{1,128}$/.test(folderId))
          return json(res, 400, { error: "Укажите корректный Folder ID" });
        if (!apiKey)
          return json(res, 400, { error: "Сначала укажите API-ключ" });
        if (!(await accountAiAccess(db, adminId, auth.local)))
          return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
        const models = await fetchAiStudioModels({
          baseUrl: runtime.baseUrl,
          apiKey,
          folderId,
          fetcher,
        });
        // Model discovery may finish after the account or archive owner is
        // downgraded. Do not deliver the completed list in that case.
        if (!(await accountAiAccess(db, adminId, auth.local)))
          return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
        return json(res, 200, { models });
      } catch (error) {
        return json(res, error instanceof RangeError ? 413 : 502, {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось получить список моделей AI Studio",
        });
      }
    }

    if (path === "/api/admin/ai/test" && req.method === "POST") {
      const role = url.searchParams.get("role");
      if (role !== null && !Object.hasOwn(ROLE_NAMES, role))
        return json(res, 400, { error: "Неизвестная роль" });
      const runtime = await aiRuntimeConfig(
        settings,
        (role as Role | undefined) || undefined,
      );
      if (!runtime.configured)
        return json(res, 400, {
          error:
            "AI Studio не настроена: задайте API-ключ и Folder ID в админке или в окружении сервера",
        });
      if (!(await accountAiAccess(db, adminId, auth.local)))
        return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
      try {
        const client = yandexResponsesClient(fetcher);
        const conversationId = await client.createConversation(runtime);
        let answer = "";
        let compactionAvailable = false;
        try {
          // Creating the remote conversation can outlive a tier downgrade.
          if (!(await accountAiAccess(db, adminId, auth.local)))
            return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
          const result = await client.respond({
            runtime,
            conversationId,
            input: "Это проверка подключения Drevo. Ответь одним словом: OK",
            instructions: "Ответь коротко.",
            tools: [
              {
                type: "function",
                name: "drevo_connection_check",
                description: "Проверочный инструмент подключения",
                parameters: { type: "object", properties: {} },
              },
            ],
            compactThreshold: runtime.compactionEnabled
              ? runtime.compactThresholdTokens
              : null,
            automaticTruncation: runtime.automaticTruncation,
          });
          answer = result.text;
          compactionAvailable = result.compactionAvailable;
          if (!(await accountAiAccess(db, adminId, auth.local)))
            return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
        } finally {
          void client
            .deleteConversation(runtime, conversationId)
            .catch(() => {});
        }
        return json(res, 200, {
          ok: true,
          model: runtime.model,
          answer: answer.trim() || "Подключение установлено",
          compactionAvailable,
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
