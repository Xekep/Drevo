import { createWebSearchService } from "./web-search.ts";
import { yandexWebSearchProvider } from "./yandex-web-search.ts";
import { recordModelCall, recordModelTokens } from "./ai-research-support.ts";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchiveUser } from "../domain/access.ts";
import { fullName } from "../domain/dates.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { aiChatStore } from "./ai-chats.ts";
import { aiRuntimeConfig, type aiSettingsStore } from "./ai-settings.ts";
import { AiLimitError, type aiUsageStore } from "./ai-usage.ts";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import type { imagePreviews } from "./image-previews.ts";
import type { mediaStore } from "./media.ts";
import type { researchCatalogStore } from "./research-catalog.ts";
import { type researchSuggestionStore } from "./research-suggestions.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { YandexResponseError } from "./yandex-responses.ts";

import { createResearchRunner } from "./ai-research-runner.ts";
import { yandexResponsesClient } from "./yandex-responses.ts";
import {
  modelUsage,
  readJson,
  type ResearchMetrics,
} from "./ai-research-support.ts";
export {
  explicitViewControlRequest,
  humanizeResearchAnswer,
  recoverTextToolCalls,
  requesterAccessContext,
  requesterPromptContext,
  shortTreeZoomRequest,
} from "./ai-research-support.ts";
function sse(res: ServerResponse, event: string, value: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

export function aiResearchHttp({
  archive,
  auth,
  suggestions,
  aiSettings,
  usage,
  media,
  previewImage,
  researchCatalog,
  publicOrigin,
  fetcher = fetch,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  suggestions: ReturnType<typeof researchSuggestionStore>;
  aiSettings: ReturnType<typeof aiSettingsStore>;
  usage: ReturnType<typeof aiUsageStore>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  researchCatalog: ReturnType<typeof researchCatalogStore>;
  publicOrigin?: string;
  fetcher?: typeof fetch;
}) {
  const chats = aiChatStore(archive.db);
  const activeRuns = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  async function stopChat(id: string) {
    const run = activeRuns.get(id);
    if (!run) return;
    run.controller.abort();
    // Keep the lease until the runner exits: a stopped turn must not write
    // after deletion or overlap a new turn.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        run.done,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 2000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  const responses = yandexResponsesClient(fetcher);
  const accessScope = (user: ArchiveUser) => {
    const identity = [user.role, user.treeAccess || "all", user.personId || ""];
    if (!isScopedUser(user)) return JSON.stringify(identity);
    const visible = projectFamilyForUser(archive.read().family, user);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify([
          visible.people.map((person) => person.id).sort(),
          (visible.photos || []).map((photo) => photo.id).sort(),
        ]),
      )
      .digest("hex");
    return JSON.stringify([...identity, fingerprint]);
  };
  const pdfFiles = new Map<
    string,
    { ownerId: string; name: string; bytes: Buffer; expires: number }
  >();
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  const runResearch = createResearchRunner({
    archive,
    suggestions,
    media,
    previewImage,
    researchCatalog,
    fetcher,
    chats,
    pdfFiles,
    webSearch: (runtime, metrics) =>
      runtime.webSearchEnabled && runtime.webSearchProvider === "yandex"
        ? createWebSearchService({
            provider: yandexWebSearchProvider({
              client: responses,
              runtime,
              onCall: () => recordModelCall(metrics, runtime.modelUri),
              onUsage: (usage) =>
                recordModelTokens(
                  metrics,
                  runtime.modelUri,
                  usage.inputTokens,
                  usage.outputTokens,
                ),
            }),
            sources: researchCatalog.webSearchSources,
            timeoutMs: runtime.webSearchTimeoutMs,
          })
        : undefined,
  });

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname,
      stream = path === "/api/ai/chat/stream";
    if (path.startsWith("/api/ai/files/")) {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      if (!auth.canRead(req))
        return json(res, 401, { error: "Войдите в архив" });
      const id = path.slice("/api/ai/files/".length),
        file = pdfFiles.get(id);
      if (
        !file ||
        file.expires < Date.now() ||
        file.ownerId !== auth.currentUser(req)?.id
      )
        return json(res, 404, {
          error: "Файл не найден или срок ссылки истёк",
        });
      res.writeHead(200, {
        "Content-Type": "application/pdf",
        "Content-Length": file.bytes.length,
        "Content-Disposition": `attachment; filename="drevo-research.pdf"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(file.bytes);
      return true;
    }
    if (
      path !== "/api/ai/status" &&
      path !== "/api/ai/chat" &&
      path !== "/api/ai/chat/stream" &&
      path !== "/api/ai/chats" &&
      !path.startsWith("/api/ai/chats/")
    )
      return false;
    if (!auth.canRead(req))
      return json(res, auth.currentUser(req) ? 403 : 401, {
        error: "Войдите в архив для работы с ИИ-исследователем",
      });

    if (path === "/api/ai/status") {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      return json(res, 200, {
        enabled: aiRuntimeConfig(aiSettings).active,
        canPropose: auth.canEdit(req),
        streaming: true,
      });
    }

    if (path === "/api/ai/chats" && req.method === "GET") {
      const user = auth.currentUser(req)!;
      return json(res, 200, { chats: chats.list(user.id, accessScope(user)) });
    }
    if (path.startsWith("/api/ai/chats/")) {
      const stopRequested = path.endsWith("/stop");
      const id = path.slice("/api/ai/chats/".length).replace(/\/stop$/, "");
      const user = auth.currentUser(req)!;
      if (!/^[a-f0-9-]{36}$/i.test(id))
        return json(res, 404, { error: "Диалог не найден" });
      if (stopRequested) {
        if (req.method !== "POST")
          return json(res, 405, { error: "Ожидается POST" });
        if (!isSameOriginRequest(req, publicOrigin))
          return json(res, 403, { error: "Invalid origin" });
        const chat = chats.read(id, user.id);
        if (!chat || chat.accessScope !== accessScope(user))
          return json(res, 404, { error: "Диалог не найден" });
        await stopChat(id);
        return json(res, 200, { busy: !!chats.isBusy(id) });
      }
      if (req.method === "GET") {
        const chat = chats.read(id, user.id);
        if (!chat || chat.accessScope !== accessScope(user))
          return json(res, 404, { error: "Диалог не найден" });
        return json(res, 200, {
          chat: {
            id: chat.id,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            busy: !!chats.isBusy(id),
          },
          messages: chats.messages(id, user.id),
        });
      }
      if (req.method === "DELETE") {
        if (!isSameOriginRequest(req, publicOrigin))
          return json(res, 403, { error: "Invalid origin" });
        const existing = chats.read(id, user.id);
        if (!existing || existing.accessScope !== accessScope(user))
          return json(res, 404, { error: "Диалог не найден" });
        await stopChat(id);
        if (chats.isBusy(id))
          return json(res, 409, {
            error: "Дождитесь завершения ответа перед удалением диалога",
          });
        const chat = chats.delete(id, user.id);
        if (!chat) return json(res, 404, { error: "Диалог не найден" });
        const remoteId =
          chat.yandexConversationId || existing.yandexConversationId;
        if (remoteId) {
          void responses
            .deleteConversation(aiRuntimeConfig(aiSettings), remoteId)
            .catch((error) =>
              console.warn(
                JSON.stringify({
                  event: "ai.remote_conversation_delete_failed",
                  localConversationId: id,
                  status:
                    error instanceof YandexResponseError
                      ? error.status
                      : undefined,
                }),
              ),
            );
        }
        return json(res, 200, { deleted: true });
      }
      return json(res, 405, { error: "Ожидается GET или DELETE" });
    }

    if (req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });
    const runtime = aiRuntimeConfig(aiSettings);
    if (!runtime.active)
      return json(res, 503, {
        error: runtime.configured
          ? "ИИ-исследователь отключён администратором"
          : "ИИ-исследователь не настроен: задайте API-ключ, Folder ID и модель",
      });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: "JSON required" });

    let body: Record<string, unknown>;
    try {
      body = (await readJson(req)) as Record<string, unknown>;
    } catch (error) {
      return json(res, error instanceof RangeError ? 413 : 400, {
        error:
          error instanceof Error ? error.message : "Некорректный JSON запроса",
      });
    }
    const user = auth.currentUser(req)!,
      canPropose = auth.canEdit(req);
    const selectedPersonId = body.selectedPersonId;
    if (
      selectedPersonId !== undefined &&
      (typeof selectedPersonId !== "string" || !selectedPersonId)
    )
      return json(res, 400, { error: "Некорректный выбор человека" });
    const typedMessage =
      typeof body.message === "string" ? body.message.trim() : "";
    if (
      typedMessage.length > 8000 ||
      (selectedPersonId && typedMessage) ||
      (!selectedPersonId && !typedMessage)
    )
      return json(res, 400, { error: "Некорректный текст запроса" });
    const requestedChatId = typeof body.chatId === "string" ? body.chatId : "";
    if (selectedPersonId && !requestedChatId)
      return json(res, 400, { error: "Выберите диалог для уточнения" });
    const family = archive.read().family;
    const visibleFamily = isScopedUser(user)
      ? projectFamilyForUser(family, user)
      : family;
    const selectedPerson = selectedPersonId
      ? visibleFamily.people.find((person) => person.id === selectedPersonId)
      : null;
    if (selectedPersonId && !selectedPerson)
      return json(res, 404, { error: "Человек не найден" });
    const message = selectedPerson
      ? `Уточнение к предыдущему вопросу: речь о ${fullName(selectedPerson)}. Продолжи ответ.`
      : typedMessage;
    try {
      usage.check(user.id, runtime.limits);
    } catch (error) {
      if (error instanceof AiLimitError) {
        if (error.retryAfterSeconds)
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
        return json(res, 429, { error: error.message });
      }
      throw error;
    }

    const chat = requestedChatId
      ? chats.read(requestedChatId, user.id)
      : chats.create(user.id, accessScope(user));
    if (!chat || chat.accessScope !== accessScope(user))
      return json(res, 404, { error: "Диалог не найден" });
    const lockToken = chats.acquire(chat.id);
    if (!lockToken)
      return json(res, 409, {
        error: "Дождитесь завершения предыдущего ответа в этом диалоге",
      });
    chats.append(
      chat.id,
      "user",
      message,
      selectedPerson ? { hidden: true } : {},
    );
    const lockRenewal = setInterval(
      () => chats.renew(chat.id, lockToken),
      20_000,
    );
    lockRenewal.unref();
    const usageRun = usage.begin(user.id, runtime.model),
      metrics: ResearchMetrics = {
        providerCalls: 0,
        agentIterations: 0,
        compactionAvailable: null,
        toolCallCount: 0,
        cachedTokens: 0,
        responseId: "",
        inputTokens: 0,
        outputTokens: 0,
        models: new Map(),
      },
      controller = new AbortController();
    let finishRun: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      finishRun = resolve;
    });
    activeRuns.set(chat.id, { controller, done });
    // The turn belongs to the saved chat, not to this browser connection.
    // Reload/disconnect detaches delivery; explicit stop/delete cancels work.

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      sse(res, "chat", { chatId: chat.id });
    }

    try {
      const result = await runResearch({
        body: { ...body, message },
        user,
        canPropose,
        runtime,
        stream,
        metrics,
        onDelta: (text) => {
          if (stream) sse(res, "delta", { text });
        },
        onStatus: (status) => {
          if (stream) sse(res, "status", { message: status });
        },
        signal: controller.signal,
        chatId: chat.id,
      });
      if (controller.signal.aborted)
        throw new DOMException("Запрос остановлен", "AbortError");
      chats.append(chat.id, "assistant", result.answer, {
        references: result.references,
        suggestionIds: result.suggestionIds,
        files: result.files,
      });
      const latestFamily = archive.read().family;
      const accessiblePeople = new Set(
        (isScopedUser(user)
          ? projectFamilyForUser(latestFamily, user)
          : latestFamily
        ).people.map((person) => person.id),
      );
      const activeIds = [
        ...new Set([
          ...chat.sessionState.activePersonIds,
          ...result.references
            .filter((item) => item.kind === "person")
            .map((item) => item.id),
        ]),
      ].filter((id) => accessiblePeople.has(id));
      chats.setActivePeople(chat.id, activeIds);
      usage.finish(usageRun.id, usageRun.started, {
        status: "ok",
        providerCalls: metrics.providerCalls,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cachedInputTokens: metrics.cachedTokens,
        models: modelUsage(metrics),
      });
      console.info(
        JSON.stringify({
          event: "ai.turn_completed",
          localConversationId: chat.id,
          yandexConversationId: chats.read(chat.id, user.id)
            ?.yandexConversationId,
          model: runtime.modelUri,
          providerCalls: metrics.providerCalls,
          agentIterations: metrics.agentIterations,
          toolCallCount: metrics.toolCallCount,
          responseId: metrics.responseId,
          inputTokens: metrics.inputTokens,
          outputTokens: metrics.outputTokens,
          cachedTokens: metrics.cachedTokens,
          compactionEnabled: runtime.compactionEnabled,
          compactionAvailable: metrics.compactionAvailable,
          compactThreshold: runtime.compactThresholdTokens,
          truncationMode: runtime.automaticTruncation ? "auto" : "disabled",
          latencyMs: Date.now() - usageRun.started,
        }),
      );

      if (stream) {
        sse(res, "done", {
          chatId: chat.id,
          answer: result.answer,
          references: result.references,
          suggestionIds: result.suggestionIds,
          uiActions: result.uiActions,
          files: result.files,
        });
        res.end();
        return true;
      }
      return json(res, 200, { ...result, chatId: chat.id });
    } catch (error) {
      chats.setRemote(chat.id, null);
      const errorMessage = controller.signal.aborted
        ? "Ответ остановлен"
        : error instanceof Error &&
            (error.name === "TimeoutError" ||
              /aborted due to timeout|timed out/i.test(error.message))
          ? "ИИ не ответил вовремя. Попробуйте повторить запрос."
          : error instanceof Error
            ? error.message
            : "Не удалось получить ответ ИИ";
      console.warn(
        JSON.stringify({
          event: "ai.turn_failed",
          localConversationId: chat.id,
          model: runtime.modelUri,
          responseId: metrics.responseId,
          agentIterations: metrics.agentIterations,
          toolCallCount: metrics.toolCallCount,
          providerErrorCode:
            error instanceof YandexResponseError ? error.code : undefined,
          providerStatus:
            error instanceof YandexResponseError ? error.status : undefined,
          latencyMs: Date.now() - usageRun.started,
        }),
      );
      usage.finish(usageRun.id, usageRun.started, {
        status: "error",
        providerCalls: metrics.providerCalls,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cachedInputTokens: metrics.cachedTokens,
        models: modelUsage(metrics),
      });
      if (stream) {
        sse(res, "error", { error: errorMessage });
        res.end();
        return true;
      }
      return json(res, error instanceof RangeError ? 400 : 502, {
        error: errorMessage,
      });
    } finally {
      clearInterval(lockRenewal);
      chats.release(chat.id, lockToken);
      if (activeRuns.get(chat.id)?.controller === controller)
        activeRuns.delete(chat.id);
      finishRun();
    }
  };
}
