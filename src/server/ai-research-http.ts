import { createWebSearchService } from "./web-search.ts";
import { dirname, join } from "node:path";
import { aiAttachmentStore, validateAttachments } from "./ai-attachments.ts";
import type { ResearchAttachment } from "../shared/research-attachments.ts";
import type { GeneratedResearchFile } from "./code-interpreter.ts";
import { pruneGeneratedResearchFiles } from "./generated-research-files.ts";
import { yandexWebSearchProvider } from "./yandex-web-search.ts";
import { recordModelCall, recordModelTokens } from "./ai-research-support.ts";
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ArchiveUser } from "../domain/access.ts";
import { fullName } from "../domain/dates.ts";
import { exportGedcom } from "../domain/gedcom.ts";
import { lineageReport } from "../domain/lineage-report.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import { aiChatStore, AiChatLimitError } from "./ai-chats.ts";
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
import { accountAiAccess } from "./account-ai-access.ts";

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
  uploadsDirectory,
}: {
  archive: Awaited<ReturnType<typeof openArchive>>;
  auth: Awaited<ReturnType<typeof createAuth>>;
  suggestions: ReturnType<typeof researchSuggestionStore>;
  aiSettings: Awaited<ReturnType<typeof aiSettingsStore>>;
  usage: ReturnType<typeof aiUsageStore>;
  media: ReturnType<typeof mediaStore>;
  previewImage: ReturnType<typeof imagePreviews>;
  researchCatalog: ReturnType<typeof researchCatalogStore>;
  publicOrigin?: string;
  fetcher?: typeof fetch;
  uploadsDirectory?: string;
}) {
  const chats = aiChatStore(archive.db);
  const attachments = aiAttachmentStore(
    uploadsDirectory || join(dirname(archive.db.file), "uploads"),
    chats,
  );
  void attachments
    .prune()
    .catch(() =>
      console.warn(JSON.stringify({ event: "ai.attachment_cleanup_failed" })),
    );
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
  const accessScope = async (user: ArchiveUser) => {
    const identity = [user.role, user.treeAccess || "all", user.personId || ""];
    if (!isScopedUser(user)) return JSON.stringify(identity);
    const visible = projectFamilyForUser((await archive.read()).family, user);
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
  const canDeliverAiData = async (req: IncomingMessage, expectedScope: string) => {
    const current = await auth.currentUser(req);
    return !!current && (await auth.canRead(req)) &&
      (await accountAiAccess(archive.db, current.id, auth.local)) &&
      (await accessScope(current)) === expectedScope;
  };
  const generatedFiles = new Map<string, GeneratedResearchFile>();
  const generatedFileCleanup = setInterval(
    () => pruneGeneratedResearchFiles(generatedFiles),
    60_000,
  );
  generatedFileCleanup.unref();
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
    generatedFiles,
    attachments,
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

  let closing = false;
  const handle = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname,
      stream = path === "/api/ai/chat/stream";
    if (path.startsWith("/api/ai/export/")) {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      const actor = await auth.currentUser(req);
      if (!actor || !(await auth.canRead(req)))
        return json(res, actor ? 403 : 401, { error: "Нет доступа к архиву" });
      if (!(await accountAiAccess(archive.db, actor.id, auth.local)))
        return json(res, 403, {
          error: "ИИ-функции недоступны этому аккаунту",
        });
      const requestedScope = await accessScope(actor);
      const source = (await archive.read()).family;
      const family = isScopedUser(actor)
        ? projectFamilyForUser(source, actor)
        : source;
      let content: string;
      let filename: string;
      let contentType: string;
      if (path === "/api/ai/export/gedcom") {
        const format = url.searchParams.get("format");
        if (format !== "gedcom7" && format !== "gedcom551")
          return json(res, 400, { error: "Неизвестный формат GEDCOM" });
        content = exportGedcom(family, {
          version: format === "gedcom7" ? "7.0" : "5.5.1",
          media: [],
        });
        filename = format === "gedcom7" ? "drevo-7.ged" : "drevo-5.5.1.ged";
        contentType = "text/vnd.familysearch.gedcom; charset=utf-8";
      } else if (path === "/api/ai/export/lineage") {
        const personId = url.searchParams.get("personId") || "";
        const direction = url.searchParams.get("direction");
        if (
          !family.people.some((person) => person.id === personId) ||
          (direction !== "ancestors" && direction !== "descendants")
        )
          return json(res, 404, {
            error: "Человек или направление не найдены",
          });
        content = lineageReport(family, personId, direction, 8);
        filename = `drevo-lineage-${direction}.txt`;
        contentType = "text/plain; charset=utf-8";
      } else return json(res, 404, { error: "Формат экспорта не найден" });
      const bytes = Buffer.from(content);
      if (!(await canDeliverAiData(req, requestedScope)))
        return json(res, 403, { error: "Доступ к данным изменился" });
      res.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": bytes.length,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(bytes);
      return true;
    }
    if (path.startsWith("/api/ai/files/")) {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      if (!(await auth.canRead(req)))
        return json(res, 401, { error: "Войдите в архив" });
      const fileUser = await auth.currentUser(req);
      if (
        !fileUser ||
        !(await accountAiAccess(archive.db, fileUser.id, auth.local))
      )
        return json(res, 403, {
          error: "ИИ-функции недоступны этому аккаунту",
        });
      const id = path.slice("/api/ai/files/".length),
        file = generatedFiles.get(id);
      const chat = file && await chats.read(file.chatId, fileUser.id);
      if (
        !file ||
        file.expires < Date.now() ||
        file.ownerId !== fileUser.id ||
        !chat || chat.accessScope !== (await accessScope(fileUser))
      )
        return json(res, 404, {
          error: "Файл не найден или срок ссылки истёк",
        });
      if (!(await canDeliverAiData(req, chat.accessScope)))
        return json(res, 403, { error: "Доступ к данным изменился" });
      res.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": file.bytes.length,
        "Content-Disposition": `attachment; filename="drevo-result.${
          file.name
            .split(".")
            .at(-1)
            ?.replace(/[^a-z0-9]/gi, "") || "bin"
        }"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
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
      !path.startsWith("/api/ai/attachments/") &&
      !path.startsWith("/api/ai/chats/")
    )
      return false;
    if (!(await auth.canRead(req)))
      return json(res, (await auth.currentUser(req)) ? 403 : 401, {
        error: "Войдите в архив для работы с ИИ-исследователем",
      });
    const aiUser = (await auth.currentUser(req))!;
    const ownHistoryCleanup =
      (req.method === "DELETE" && /^\/api\/ai\/chats\/[a-f0-9-]{36}$/i.test(path)) ||
      (req.method === "POST" && /^\/api\/ai\/chats\/[a-f0-9-]{36}\/stop$/i.test(path));
    if (!(await accountAiAccess(archive.db, aiUser.id, auth.local)) && !ownHistoryCleanup) {
      if (path === "/api/ai/status")
        return json(res, 200, {
          enabled: false,
          canPropose: false,
          streaming: true,
        });
      return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
    }

    if (path === "/api/ai/status") {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      const user = (await auth.currentUser(req))!;
      const runtime = await aiRuntimeConfig(aiSettings, user.role);
      return json(res, 200, {
        enabled: runtime.active,
        canPropose: runtime.capabilities.proposals && (await auth.canEdit(req)),
        streaming: true,
        attachments: {
          photoAnalysis: runtime.capabilities.photoAnalysis,
          codeInterpreter: runtime.capabilities.codeInterpreter,
        },
      });
    }

    if (path.startsWith("/api/ai/attachments/")) {
      if (req.method !== "GET")
        return json(res, 405, { error: "Ожидается GET" });
      const match =
        /^\/api\/ai\/attachments\/([a-f0-9-]{36})\/([a-f0-9-]{36})$/i.exec(
          path,
        );
      const chat = match && (await chats.read(match[1], aiUser.id));
      if (!chat || chat.accessScope !== (await accessScope(aiUser)))
        return json(res, 404, { error: "Вложение не найдено" });
      const item = await attachments
        .download(chat.id, aiUser.id, path)
        .catch(() => null);
      if (!item) return json(res, 404, { error: "Вложение не найдено" });
      if (!(await canDeliverAiData(req, chat.accessScope)))
        return json(res, 403, { error: "Доступ к данным изменился" });
      res.writeHead(200, {
        "Content-Type": item.file.type,
        "Content-Length": item.bytes.length,
        "Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(item.file.name)}`,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(item.bytes);
      return true;
    }

    if (path === "/api/ai/chats" && req.method === "GET") {
      const user = (await auth.currentUser(req))!;
      return json(res, 200, {
        chats: await chats.list(user.id, await accessScope(user)),
      });
    }
    if (path.startsWith("/api/ai/chats/")) {
      const stopRequested = path.endsWith("/stop");
      const id = path.slice("/api/ai/chats/".length).replace(/\/stop$/, "");
      const user = (await auth.currentUser(req))!;
      if (!/^[a-f0-9-]{36}$/i.test(id))
        return json(res, 404, { error: "Диалог не найден" });
      if (stopRequested) {
        if (req.method !== "POST")
          return json(res, 405, { error: "Ожидается POST" });
        if (!isSameOriginRequest(req, publicOrigin))
          return json(res, 403, { error: "Invalid origin" });
        const chat = await chats.read(id, user.id);
        if (!chat)
          return json(res, 404, { error: "Диалог не найден" });
        await stopChat(id);
        return json(res, 200, { busy: !!(await chats.isBusy(id)) });
      }
      if (req.method === "GET") {
        const chat = await chats.read(id, user.id);
        if (!chat || chat.accessScope !== (await accessScope(user)))
          return json(res, 404, { error: "Диалог не найден" });
        return json(res, 200, {
          chat: {
            id: chat.id,
            createdAt: chat.createdAt,
            updatedAt: chat.updatedAt,
            busy: !!(await chats.isBusy(id)),
          },
          messages: await chats.messages(id, user.id),
        });
      }
      if (req.method === "DELETE") {
        if (!isSameOriginRequest(req, publicOrigin))
          return json(res, 403, { error: "Invalid origin" });
        const existing = await chats.read(id, user.id);
        if (!existing) return json(res, 404, { error: "Диалог не найден" });
        await stopChat(id);
        if (await chats.isBusy(id))
          return json(res, 409, {
            error: "Дождитесь завершения ответа перед удалением диалога",
          });
        const chat = await chats.delete(id, user.id);
        if (!chat) return json(res, 404, { error: "Диалог не найден" });
        await attachments
          .deleteChat(id)
          .catch(() =>
            console.warn(
              JSON.stringify({ event: "ai.attachment_cleanup_failed" }),
            ),
          );
        const remoteId =
          chat.yandexConversationId || existing.yandexConversationId;
        if (remoteId) {
          void responses
            .deleteConversation(await aiRuntimeConfig(aiSettings), remoteId)
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
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return json(res, 415, { error: "JSON required" });

    let body: Record<string, unknown>;
    try {
      body = (await readJson(req, 14 * 1024 * 1024)) as Record<string, unknown>;
      if (!body || typeof body !== "object" || Array.isArray(body))
        throw new Error("Некорректный запрос");
    } catch (error) {
      return json(res, error instanceof RangeError ? 413 : 400, {
        error:
          error instanceof Error ? error.message : "Некорректный JSON запроса",
      });
    }
    const user = await auth.currentUser(req);
    if (!user?.approved)
      return json(res, 403, { error: "Доступ к архиву отозван" });
    // A large attachment may arrive after the owner's tier was downgraded.
    if (!(await accountAiAccess(archive.db, user.id, auth.local)))
      return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
    const runtime = await aiRuntimeConfig(aiSettings, user.role);
    if (!runtime.active)
      return json(res, 503, {
        error: runtime.configured
          ? "ИИ-исследователь отключён администратором"
          : "ИИ-исследователь не настроен: задайте API-ключ, Folder ID и модель",
      });
    const canPropose =
      runtime.capabilities.proposals && (await auth.canEdit(req));
    let preparedAttachments;
    try {
      preparedAttachments = await validateAttachments(
        body.attachments,
        runtime.capabilities,
      );
      delete body.attachments;
    } catch (error) {
      return json(res, 400, {
        error:
          error instanceof RangeError
            ? error.message
            : "Не удалось прочитать вложения",
      });
    }
    const selectedPersonId = body.selectedPersonId;
    if (
      selectedPersonId !== undefined &&
      (typeof selectedPersonId !== "string" || !selectedPersonId)
    )
      return json(res, 400, { error: "Некорректный выбор человека" });
    const typedMessage =
      typeof body.message === "string" && body.message.trim()
        ? body.message.trim()
        : preparedAttachments.length
          ? "Изучи прикреплённые файлы."
          : "";
    if (
      typedMessage.length > 8000 ||
      (selectedPersonId && typedMessage) ||
      (!selectedPersonId && !typedMessage)
    )
      return json(res, 400, { error: "Некорректный текст запроса" });
    const requestedChatId = typeof body.chatId === "string" ? body.chatId : "";
    if (selectedPersonId && !requestedChatId)
      return json(res, 400, { error: "Выберите диалог для уточнения" });
    const family = (await archive.read()).family;
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
      await usage.check(user.id, runtime.limits);
      if (runtime.userLimits)
        await usage.check(user.id, runtime.userLimits, "user");
    } catch (error) {
      if (error instanceof AiLimitError) {
        if (error.retryAfterSeconds)
          res.setHeader("Retry-After", String(error.retryAfterSeconds));
        return json(res, 429, { error: error.message });
      }
      throw error;
    }

    let chat;
    try {
      chat = requestedChatId
        ? await chats.read(requestedChatId, user.id)
        : await chats.create(user.id, await accessScope(user));
    } catch (error) {
      if (error instanceof AiChatLimitError)
        return json(res, 409, { code: "AI_CHAT_LIMIT", error: error.message });
      throw error;
    }
    if (!chat || chat.accessScope !== (await accessScope(user)))
      return json(res, 404, { error: "Диалог не найден" });
    if (closing)
      return json(res, 503, {
        error: "Сервер перезапускается. Повторите запрос.",
      });
    const lockToken = await chats.acquire(chat.id);
    if (!lockToken)
      return json(res, 409, {
        error: "Дождитесь завершения предыдущего ответа в этом диалоге",
      });
    let usageRun: Awaited<ReturnType<typeof usage.begin>>;
    let savedAttachments: ResearchAttachment[] = [];
    let appended = false;
    try {
      if (closing) throw new Error("Сервер перезапускается");
      if (!(await accountAiAccess(archive.db, user.id, auth.local))) {
        await chats.release(chat.id, lockToken);
        return json(res, 403, { error: "ИИ-функции недоступны этому аккаунту" });
      }
      const oldFiles =
        (await chats.messages(chat.id, user.id))?.flatMap(
          (item) => item.attachments || [],
        ) || [];
      if (
        preparedAttachments.length &&
        oldFiles.length + preparedAttachments.length > 100
      ) {
        await chats.release(chat.id, lockToken);
        return json(res, 400, {
          error: "В библиотеке уже 100 файлов. Создайте новый диалог.",
        });
      }
      if (
        preparedAttachments.length &&
        oldFiles.reduce((size, file) => size + file.size, 0) +
          preparedAttachments.reduce(
            (size, file) => size + file.bytes.length,
            0,
          ) >
          100 * 1024 * 1024
      ) {
        await chats.release(chat.id, lockToken);
        return json(res, 400, {
          error: "В диалоге уже 100 МБ вложений. Создайте новый диалог.",
        });
      }
      try {
        savedAttachments = await attachments.save(chat.id, preparedAttachments);
      } catch {
        await chats.release(chat.id, lockToken);
        return json(res, 503, {
          error:
            "Не удалось сохранить вложения. Попробуйте позже или обратитесь к администратору.",
        });
      }
      await chats.append(
        chat.id,
        "user",
        message,
        selectedPerson
          ? { hidden: true }
          : {
              ...(savedAttachments.length
                ? { attachments: savedAttachments }
                : {}),
            },
      );
      appended = true;
      usageRun = await usage.begin(user.id, runtime.model);
      if (closing) throw new Error("Сервер перезапускается");
    } catch (error) {
      if (!appended) await attachments.removeFiles(savedAttachments);
      await chats.release(chat.id, lockToken);
      throw error;
    }
    const metrics: ResearchMetrics = {
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
    let renewing = false;
    let leaseLost = false;
    let accessRevoked = false;
    const lockRenewal = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void accountAiAccess(archive.db, user.id, auth.local)
        .then((allowed) => {
          if (!allowed) {
            accessRevoked = true;
            controller.abort();
            return false;
          }
          return chats.renew(chat.id, lockToken);
        })
        .then((held) => {
          if (!held && !accessRevoked) {
            leaseLost = true;
            controller.abort();
          } else if (held && stream && !res.writableEnded && !res.destroyed) {
            res.write(": keep-alive\n\n");
          }
        })
        .catch(() => {
          leaseLost = true;
          controller.abort();
          console.warn(
            JSON.stringify({
              event: "ai.chat_lease_lost",
              localConversationId: chat.id,
            }),
          );
        })
        .finally(() => {
          renewing = false;
        });
    }, 20_000);
    lockRenewal.unref();
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
      if (savedAttachments.length)
        sse(res, "attachments", { attachments: savedAttachments });
    }

    try {
      if (!(await accountAiAccess(archive.db, user.id, auth.local))) {
        accessRevoked = true;
        throw new DOMException("Доступ к ИИ отключён", "AbortError");
      }
      const result = await runResearch({
        body: { ...body, message },
        user,
        canPropose,
        runtime,
        stream,
        metrics,
        // The browser does not consume deltas. Delivering them before the
        // final access check would leak an answer after a tier downgrade.
        onDelta: () => {},
        onStatus: (status) => {
          if (stream) sse(res, "status", { message: status });
        },
        signal: controller.signal,
        chatId: chat.id,
      });
      if (controller.signal.aborted)
        throw new DOMException("Запрос остановлен", "AbortError");
      if (!(await accountAiAccess(archive.db, user.id, auth.local))) {
        accessRevoked = true;
        throw new DOMException("Доступ к ИИ отключён", "AbortError");
      }
      await chats.append(chat.id, "assistant", result.answer, {
        references: result.references,
        suggestionIds: result.suggestionIds,
        files: result.files,
      });
      const latestFamily = (await archive.read()).family;
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
      await chats.setActivePeople(chat.id, activeIds);
      await usage.finish(usageRun.id, usageRun.started, {
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
          yandexConversationId: (await chats.read(chat.id, user.id))
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
      await chats.setRemote(chat.id, null);
      const errorMessage = accessRevoked
        ? "Доступ к ИИ отключён. Ответ не сохранён."
        : leaseLost
          ? "Соединение с архивом прервано. Повторите запрос после восстановления связи."
          : controller.signal.aborted
            ? "Ответ остановлен"
            : error instanceof Error &&
                (error.name === "TimeoutError" ||
                  /aborted due to timeout|timed out/i.test(error.message))
              ? "ИИ не ответил вовремя. Попробуйте повторить запрос."
              : error instanceof YandexResponseError
                ? error.status === 401 || error.status === 403
                  ? "Yandex AI отклонил доступ. Администратору нужно проверить API-ключ и права на модель и диалоги в разделе Yandex AI."
                  : (error.status === 400 || error.status === 422) &&
                      preparedAttachments.length
                    ? "Модель ИИ не приняла вложение. Для PDF нужна модель с поддержкой файлов; проверьте её в настройках ИИ или отправьте текст/изображение страницы. Файлы сохранены в диалоге."
                    : error.status === 429
                      ? "Yandex AI ограничил частоту запросов. Повторите немного позже."
                      : error.code === "provider_timeout"
                        ? "Yandex AI не завершил ответ вовремя. История диалога сохранена; запрос можно повторить."
                        : error.code === "incomplete_max_output_tokens"
                          ? "ИИ исчерпал лимит длины ответа и рассуждений. Ответ не завершён. История сохранена; попробуйте разделить вопрос на несколько частей."
                          : error.code === "incomplete_content_filter"
                            ? "Yandex AI остановил ответ фильтром содержимого. Это не означает, что в архиве нет нужных данных. Попробуйте уточнить запрос."
                            : "Сервис ИИ не смог завершить ответ. История диалога сохранена; запрос можно повторить."
                : error instanceof Error
                  ? error.message
                  : "Не удалось получить ответ ИИ";
      console.warn(
        JSON.stringify({
          event: "ai.turn_failed",
          localConversationId: chat.id,
          model: runtime.modelUri,
          responseId:
            error instanceof YandexResponseError && error.responseId
              ? error.responseId
              : metrics.responseId,
          agentIterations: metrics.agentIterations,
          toolCallCount: metrics.toolCallCount,
          providerErrorCode:
            error instanceof YandexResponseError ? error.code : undefined,
          providerStatus:
            error instanceof YandexResponseError ? error.status : undefined,
          providerEndpoint:
            error instanceof YandexResponseError ? error.endpoint : undefined,
          errorType: error instanceof Error ? error.name : "unknown",
          latencyMs: Date.now() - usageRun.started,
        }),
      );
      await usage.finish(usageRun.id, usageRun.started, {
        status: "error",
        providerCalls: metrics.providerCalls,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
        cachedInputTokens: metrics.cachedTokens,
        models: modelUsage(metrics),
      });
      if (
        !leaseLost &&
        !controller.signal.aborted &&
        (error instanceof YandexResponseError ||
          (error instanceof Error && error.name === "TimeoutError"))
      ) {
        // Keep a safe operational fact for the next turn, never upstream text.
        // The visible error is delivered separately through HTTP/SSE.
        await chats.append(
          chat.id,
          "assistant",
          `Служебный статус предыдущего ответа: ${errorMessage}`,
          { hidden: true },
        );
      }
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
      try {
        await chats.release(chat.id, lockToken);
      } finally {
        if (activeRuns.get(chat.id)?.controller === controller)
          activeRuns.delete(chat.id);
        finishRun();
      }
    }
  };
  return Object.assign(handle, {
    async close() {
      closing = true;
      clearInterval(generatedFileCleanup);
      const runs = [...activeRuns.values()];
      for (const run of runs) run.controller.abort();
      await Promise.all(runs.map((run) => run.done));
      generatedFiles.clear();
    },
  });
}
