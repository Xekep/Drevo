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
import type { AiProviderCleanup } from "./ai-provider-cleanup.ts";
import {
  assertCurrentPlatformAdmin,
  assertPlatformAdminInArchiveTransaction,
  PlatformAccessBusy,
  PlatformAccessDenied,
} from "./platform-access.ts";
import { finished } from "node:stream/promises";

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
  providerCleanup,
  publicOrigin,
  fetcher = fetch,
}: {
  auth: Awaited<ReturnType<typeof createAuth>>;
  db: StoreDatabase;
  settings: Awaited<ReturnType<typeof aiSettingsStore>>;
  usage: ReturnType<typeof aiUsageStore>;
  providerCleanup?: AiProviderCleanup;
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
  const statusValue = async (req: IncomingMessage) => {
    const runtime = await aiRuntimeConfig(settings);
    // Loading settings can outlive a platform grant revocation.
    if (!(await auth.isPlatformAdmin(req))) return null;
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
    if (!(await auth.isPlatformAdmin(req)))
      return json(res, (await auth.accountId(req)) ? 403 : 401, {
        error: "Только администратор может управлять AI Studio",
      });
    const platformOnly = db.kind === "postgres" && !auth.local;
    const admin = platformOnly
      ? await auth.accountProfile(req)
      : await auth.currentUser(req);
    if (!admin)
      return json(res, 401, { error: "Сеанс завершён. Войдите снова." });
    const session = platformOnly ? await auth.accountSession(req) : null;
    if (platformOnly && !session)
      return json(res, 401, { error: "Сеанс завершён" });
    const adminId = admin.id;
    const stillAdmin = async () => {
      const current = platformOnly
        ? await auth.accountProfile(req)
        : await auth.currentUser(req);
      const activeSession = platformOnly
        ? await auth.accountSession(req)
        : null;
      return (
        current?.id === adminId &&
        (!platformOnly || activeSession?.tokenHash === session?.tokenHash) &&
        (await auth.isPlatformAdmin(req))
      );
    };
    const deliver = async (status: number, value: unknown) => {
      if (!platformOnly || !db.postgresTransaction)
        return json(res, status, value);
      try {
        return await db.postgresTransaction(async (client) => {
          await assertCurrentPlatformAdmin(client, adminId, session!.tokenHash);
          const timer = setTimeout(
            () => res.destroy(new Error("AI settings delivery timed out")),
            4_000,
          );
          timer.unref();
          try {
            const done = finished(res, { cleanup: true });
            json(res, status, value);
            await done;
            return true;
          } finally {
            clearTimeout(timer);
          }
        });
      } catch (error) {
        if (res.headersSent || res.destroyed) {
          res.destroy(error as Error);
          return true;
        }
        if (
          error instanceof PlatformAccessDenied ||
          error instanceof PlatformAccessBusy
        )
          return json(res, error instanceof PlatformAccessBusy ? 409 : 403, {
            error: "Права администратора платформы изменились",
          });
        throw error;
      }
    };

    if (path === "/api/admin/ai" && req.method === "GET") {
      const status = await statusValue(req);
      if (!status || !(await stillAdmin()))
        return json(res, 403, { error: "Доступ отозван" });
      return deliver(200, status);
    }

    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });

    if (path === "/api/admin/ai" && req.method === "PUT") {
      if (!req.headers["content-type"]?.startsWith("application/json"))
        return json(res, 415, { error: "JSON required" });
      try {
        const body = await readJson(req);
        if (!(await stillAdmin()))
          return json(res, 403, { error: "Доступ отозван" });
        await db.transaction(async () => {
          if (platformOnly)
            await assertPlatformAdminInArchiveTransaction(
              db,
              adminId,
              session!.tokenHash,
            );
          await settings.write(body, admin);
        });
        const status = await statusValue(req);
        if (!status || !(await stillAdmin()))
          return json(res, 403, { error: "Доступ отозван" });
        return deliver(200, status);
      } catch (error) {
        if (
          error instanceof PlatformAccessBusy ||
          error instanceof PlatformAccessDenied
        )
          return json(res, error instanceof PlatformAccessBusy ? 409 : 403, {
            error: "Права администратора платформы изменились",
          });
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
        if (!(await stillAdmin()))
          return json(res, 403, { error: "Доступ отозван" });
        const models = await fetchAiStudioModels({
          baseUrl: runtime.baseUrl,
          apiKey,
          folderId,
          fetcher,
        });
        // Model discovery may finish after platform access is revoked.
        if (!(await stillAdmin()))
          return json(res, 403, { error: "Доступ отозван" });
        return deliver(200, { models });
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
      let runtime: Awaited<ReturnType<typeof aiRuntimeConfig>>;
      try {
        const hasBody =
          Number(req.headers["content-length"] || 0) > 0 ||
          req.headers["transfer-encoding"] !== undefined;
        if (
          hasBody &&
          !req.headers["content-type"]?.startsWith("application/json")
        )
          return json(res, 415, { error: "JSON required" });
        runtime = await aiRuntimeConfig(
          hasBody ? await settings.preview(await readJson(req)) : settings,
          (role as Role | undefined) || undefined,
        );
      } catch (error) {
        return json(res, error instanceof RangeError ? 413 : 400, {
          error:
            error instanceof Error
              ? error.message
              : "Некорректные настройки AI Studio",
        });
      }
      if (!runtime.configured)
        return json(res, 400, {
          error:
            "AI Studio не настроена: задайте API-ключ и Folder ID в админке или в окружении сервера",
        });
      if (!(await stillAdmin()))
        return json(res, 403, { error: "Доступ отозван" });
      try {
        const client = yandexResponsesClient(fetcher);
        // This deadline covers creation and every possible model fallback.
        // The durable provisional binding outlives it by a full minute.
        const signal = AbortSignal.timeout(240_000);
        if (db.kind === "postgres") {
          if (!providerCleanup) throw new Error("AI cleanup is unavailable");
          await providerCleanup.assertReady();
        }
        const conversationId = await client.createConversation(runtime, signal);
        let answer = "";
        let compactionAvailable = false;
        let cleanupRef: string | null = null;
        try {
          if (providerCleanup)
            cleanupRef = await providerCleanup.registerTest(
              conversationId,
              runtime,
            );
          // Creating the remote conversation can outlive a platform grant.
          if (!(await stillAdmin()))
            return json(res, 403, { error: "Доступ отозван" });
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
            signal,
          });
          answer = result.text;
          compactionAvailable = result.compactionAvailable;
          if (!(await stillAdmin()))
            return json(res, 403, { error: "Доступ отозван" });
        } finally {
          if (cleanupRef) await providerCleanup!.pending(cleanupRef);
          else if (db.kind !== "postgres")
            void client
              .deleteConversation(runtime, conversationId)
              .catch(() => {});
        }
        if (!(await stillAdmin()))
          return json(res, 403, { error: "Доступ отозван" });
        return deliver(200, {
          ok: true,
          model: runtime.model,
          answer: answer.trim() || "Подключение установлено",
          compactionAvailable,
        });
      } catch {
        // Provider error text may contain remote IDs or request details.
        return json(res, 502, {
          error: "Не удалось проверить подключение AI Studio",
        });
      }
    }

    res.setHeader("Allow", "GET, PUT, POST");
    return json(res, 405, { error: "Method not allowed" });
  };
}
