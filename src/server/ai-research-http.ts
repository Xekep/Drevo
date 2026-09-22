import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import {
  aiRuntimeConfig,
  type aiSettingsStore,
} from "./ai-settings.ts";
import { fullName } from "../domain/dates.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import {
  executeResearchTool,
  RESEARCH_TOOL_DEFINITIONS,
} from "../domain/research-tools.ts";
import {
  RESEARCH_PROPOSAL_TOOLS,
  type researchSuggestionStore,
} from "./research-suggestions.ts";
import {
  AiLimitError,
  type aiUsageStore,
} from "./ai-usage.ts";

type ToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};
type ModelMessage = {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};
type ModelUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};
type ModelResponse = {
  choices?: Array<{ message?: ModelMessage }>;
  error?: { message?: string };
  usage?: ModelUsage;
};
type StreamToolCallDelta = {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
};
type ModelStreamChunk = {
  choices?: Array<{
    delta?: {
      role?: string;
      content?: string | null;
      tool_calls?: StreamToolCallDelta[];
    };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
  usage?: ModelUsage;
};

type AnswerReference =
  | { kind: "person"; id: string; label: string }
  | {
      kind: "source";
      personId: string;
      label: string;
      reference?: string;
      url?: string;
    };

type ResearchMetrics = {
  providerCalls: number;
  inputTokens: number;
  outputTokens: number;
};

type ResearchResult = {
  answer: string;
  references: AnswerReference[];
};

function estimateTokens(value: unknown) {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(1, Math.ceil(serialized.length / 4));
}

function usageTokens(usage: ModelUsage | undefined) {
  const input = usage?.prompt_tokens ?? usage?.input_tokens,
    output = usage?.completion_tokens ?? usage?.output_tokens;
  return {
    input:
      typeof input === "number" && Number.isFinite(input)
        ? Math.max(0, input)
        : undefined,
    output:
      typeof output === "number" && Number.isFinite(output)
        ? Math.max(0, output)
        : undefined,
  };
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new RangeError("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validHistory(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(-12).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>,
      role = row.role,
      content = row.content;
    return (role === "user" || role === "assistant") &&
      typeof content === "string" &&
      content.length <= 6000
      ? [{ role, content }]
      : [];
  });
}

function collectPersonReferences(
  value: unknown,
  people: Map<string, string>,
  ids: Set<string>,
) {
  if (typeof value === "string") {
    if (people.has(value)) ids.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPersonReferences(item, people, ids);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const item of Object.values(value as Record<string, unknown>))
    collectPersonReferences(item, people, ids);
}

function collectSourceReferences(
  value: unknown,
  personId: string,
  sources: Map<string, Extract<AnswerReference, { kind: "source" }>>,
) {
  if (Array.isArray(value)) {
    for (const item of value) collectSourceReferences(item, personId, sources);
    return;
  }
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>,
    label =
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : "",
    reference =
      typeof record.reference === "string" && record.reference.trim()
        ? record.reference.trim()
        : undefined,
    rawUrl =
      typeof record.url === "string" && record.url.trim()
        ? record.url.trim()
        : undefined,
    url = rawUrl && /^https?:\/\/[^\s]+$/i.test(rawUrl) ? rawUrl : undefined;
  if (label && (reference || url)) {
    const key = `${personId}\0${label}\0${reference || ""}\0${url || ""}`;
    sources.set(key, {
      kind: "source",
      personId,
      label,
      ...(reference ? { reference } : {}),
      ...(url ? { url } : {}),
    });
  }
  for (const item of Object.values(record))
    collectSourceReferences(item, personId, sources);
}

function sse(res: ServerResponse, event: string, value: unknown) {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function parseSseData(frame: string) {
  return frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
}

export function aiResearchHttp({
  archive,
  auth,
  suggestions,
  aiSettings,
  usage,
  publicOrigin,
  fetcher = fetch,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  suggestions: ReturnType<typeof researchSuggestionStore>;
  aiSettings: ReturnType<typeof aiSettingsStore>;
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

  function requestBody(
    messages: ModelMessage[],
    canPropose: boolean,
    runtime: ReturnType<typeof aiRuntimeConfig>,
    stream = false,
  ) {
    const definitions = [
      ...RESEARCH_TOOL_DEFINITIONS,
      ...(canPropose ? RESEARCH_PROPOSAL_TOOLS : []),
    ];
    return {
      model: runtime.modelUri,
      messages,
      temperature: 0.2,
      tool_choice: "auto",
      tools: definitions.map((definition) => ({
        type: "function",
        function: {
          name: definition.name,
          description: definition.description,
          parameters: definition.inputSchema,
        },
      })),
      ...(stream ? { stream: true } : {}),
    };
  }

  function providerHeaders(runtime: ReturnType<typeof aiRuntimeConfig>) {
    return {
      Authorization: `Api-Key ${runtime.apiKey}`,
      "Content-Type": "application/json",
      ...(runtime.folderId ? { "OpenAI-Project": runtime.folderId } : {}),
    };
  }

  async function complete(
    messages: ModelMessage[],
    canPropose: boolean,
    runtime: ReturnType<typeof aiRuntimeConfig>,
  ): Promise<{
    message: ModelMessage;
    inputTokens: number;
    outputTokens: number;
  }> {
    const body = requestBody(messages, canPropose, runtime),
      response = await fetcher(`${runtime.baseUrl}/chat/completions`, {
        method: "POST",
        headers: providerHeaders(runtime),
        body: JSON.stringify(body),
      }),
      data = (await response.json()) as ModelResponse;
    if (!response.ok)
      throw new Error(
        data.error?.message ||
          `Yandex AI Studio вернула HTTP ${response.status}`,
      );
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("Yandex AI Studio не вернула ответ");
    const reported = usageTokens(data.usage);
    return {
      message,
      inputTokens: reported.input ?? estimateTokens(body),
      outputTokens: reported.output ?? estimateTokens(message),
    };
  }

  async function completeStream(
    messages: ModelMessage[],
    canPropose: boolean,
    runtime: ReturnType<typeof aiRuntimeConfig>,
    onDelta: (text: string) => void,
    signal: AbortSignal,
  ): Promise<{
    message: ModelMessage;
    inputTokens: number;
    outputTokens: number;
  }> {
    const body = requestBody(messages, canPropose, runtime, true),
      response = await fetcher(`${runtime.baseUrl}/chat/completions`, {
        method: "POST",
        headers: providerHeaders(runtime),
        body: JSON.stringify(body),
        signal,
      });

    if (!response.ok) {
      const raw = await response.text();
      let message = "";
      try {
        message = (JSON.parse(raw) as ModelResponse).error?.message || "";
      } catch {
        message = raw.trim();
      }
      throw new Error(
        message || `Yandex AI Studio вернула HTTP ${response.status}`,
      );
    }
    if (!response.body)
      throw new Error("Yandex AI Studio не вернула поток ответа");

    const reader = response.body.getReader(),
      decoder = new TextDecoder(),
      toolCalls = new Map<
        number,
        { id: string; type?: string; function: { name: string; arguments: string } }
      >();
    let buffer = "",
      content = "",
      reportedUsage: ModelUsage | undefined;

    const consumeFrame = (frame: string) => {
      const dataText = parseSseData(frame);
      if (!dataText || dataText === "[DONE]") return;
      let chunk: ModelStreamChunk;
      try {
        chunk = JSON.parse(dataText) as ModelStreamChunk;
      } catch {
        throw new Error("AI Studio вернула некорректный поток SSE");
      }
      if (chunk.error?.message) throw new Error(chunk.error.message);
      if (chunk.usage) reportedUsage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onDelta(delta.content);
      }
      for (const item of delta.tool_calls || []) {
        const index =
            typeof item.index === "number" && Number.isInteger(item.index)
              ? item.index
              : 0,
          current = toolCalls.get(index) || {
            id: "",
            function: { name: "", arguments: "" },
          };
        if (item.id) current.id = item.id;
        if (item.type) current.type = item.type;
        if (item.function?.name) current.function.name += item.function.name;
        if (item.function?.arguments)
          current.function.arguments += item.function.arguments;
        toolCalls.set(index, current);
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (!match || match.index === undefined) break;
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        consumeFrame(frame);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) consumeFrame(buffer);

    const calls = [...toolCalls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, call]) => call)
        .filter((call) => call.id && call.function.name),
      message: ModelMessage = {
        role: "assistant",
        content: content || null,
        ...(calls.length ? { tool_calls: calls } : {}),
      },
      reported = usageTokens(reportedUsage);

    return {
      message,
      inputTokens: reported.input ?? estimateTokens(body),
      outputTokens: reported.output ?? estimateTokens(message),
    };
  }

  async function runResearch({
    body,
    user,
    canPropose,
    runtime,
    stream,
    metrics,
    onDelta,
    onStatus,
    signal,
  }: {
    body: Record<string, unknown>;
    user: NonNullable<ReturnType<ReturnType<typeof createAuth>["currentUser"]>>;
    canPropose: boolean;
    runtime: ReturnType<typeof aiRuntimeConfig>;
    stream: boolean;
    metrics: ResearchMetrics;
    onDelta: (text: string) => void;
    onStatus: (text: string) => void;
    signal: AbortSignal;
  }): Promise<ResearchResult> {
    const message =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 8000)
      throw new RangeError("Некорректный текст запроса");

    const snapshot = archive.read(),
      fullFamily = snapshot.family,
      family = isScopedUser(user)
        ? projectFamilyForUser(fullFamily, user)
        : fullFamily,
      context =
        body.context && typeof body.context === "object"
          ? (body.context as Record<string, unknown>)
          : {},
      personIds = Array.isArray(context.personIds)
        ? context.personIds
            .filter((id): id is string => typeof id === "string")
            .filter((id) => family.people.some((person) => person.id === id))
            .slice(0, 2)
        : [],
      view = typeof context.view === "string" ? context.view : "",
      system = [
        "Ты исследователь семейного архива Drevo.",
        "Опирайся только на данные инструментов и слова пользователя.",
        "Не превращай предположение в факт. Явно разделяй подтверждённые сведения, вычисляемые противоречия и гипотезы для дальнейшего поиска.",
        "Если для ответа нужны данные архива, вызывай инструменты вместо догадок.",
        "Не утверждай, что отсутствие записи доказывает отсутствие события или родства.",
        canPropose
          ? "Если пользователь просит сохранить конкретную гипотезу, используй подходящий propose_person_update, propose_source или propose_relation. Это только предложения: человек отдельно принимает или отклоняет их. Не создавай предложение без конкретных значений и основания. Для parent fromPersonId означает родителя, toPersonId — ребёнка."
          : "",
        "Отвечай по-русски, кратко и предметно.",
        personIds.length
          ? `Сейчас в интерфейсе выбраны люди: ${personIds.join(", ")}.`
          : "",
        view ? `Текущий раздел интерфейса: ${view}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      messages: ModelMessage[] = [
        { role: "system", content: system },
        ...validHistory(body.history),
        { role: "user", content: message },
      ],
      peopleById = new Map(
        family.people.map((person) => [person.id, fullName(person)]),
      ),
      referencedPeople = new Set<string>(),
      referencedSources = new Map<
        string,
        Extract<AnswerReference, { kind: "source" }>
      >();

    onStatus("Обрабатываю запрос…");

    for (let round = 0; round < 8; round++) {
      metrics.providerCalls++;
      const completion = stream
          ? await completeStream(
              messages,
              canPropose,
              runtime,
              onDelta,
              signal,
            )
          : await complete(messages, canPropose, runtime),
        answer = completion.message;
      metrics.inputTokens += completion.inputTokens;
      metrics.outputTokens += completion.outputTokens;
      messages.push(answer);

      const calls = answer.tool_calls || [];
      if (!calls.length) {
        const references: AnswerReference[] = [
          ...[...referencedPeople]
            .slice(0, 12)
            .map((id) => ({
              kind: "person" as const,
              id,
              label: peopleById.get(id)!,
            })),
          ...[...referencedSources.values()].slice(0, 8),
        ];
        return {
          answer:
            typeof answer.content === "string" && answer.content.trim()
              ? answer.content
              : "Модель не сформировала текстовый ответ.",
          references,
        };
      }

      onStatus("Проверяю данные архива…");
      for (const call of calls) {
        const definition = RESEARCH_TOOL_DEFINITIONS.find(
          (item) => item.name === call.function.name,
        );
        let result: unknown,
          toolArgs: unknown = {};
        try {
          toolArgs = JSON.parse(call.function.arguments || "{}");
          if (definition)
            result = executeResearchTool(family, definition.name, toolArgs);
          else if (
            canPropose &&
            RESEARCH_PROPOSAL_TOOLS.some(
              (tool) => tool.name === call.function.name,
            )
          )
            result = {
              suggestion: suggestions.createFromTool(
                call.function.name,
                user,
                family,
                snapshot.revision,
                toolArgs,
              ),
            };
          else throw new Error("Модель запросила неизвестный инструмент");
        } catch (error) {
          result = {
            error:
              error instanceof Error
                ? error.message
                : "Ошибка исследовательского инструмента",
          };
        }
        collectPersonReferences(result, peopleById, referencedPeople);
        if (
          definition?.name === "get_sources" &&
          toolArgs &&
          typeof toolArgs === "object" &&
          typeof (toolArgs as Record<string, unknown>).personId === "string"
        )
          collectSourceReferences(
            result,
            String((toolArgs as Record<string, unknown>).personId),
            referencedSources,
          );
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      onStatus("Формирую ответ…");
    }
    throw new Error("ИИ превысил допустимое число вызовов инструментов");
  }

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname,
      stream = path === "/api/ai/chat/stream";
    if (
      path !== "/api/ai/status" &&
      path !== "/api/ai/chat" &&
      path !== "/api/ai/chat/stream"
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

    if (req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });
    const runtime = aiRuntimeConfig(aiSettings);
    if (!runtime.active)
      return json(res, 503, {
        error: runtime.configured
          ? "ИИ-исследователь отключён администратором"
          : "ИИ-исследователь не настроен: задайте YANDEX_AI_API_KEY и YANDEX_AI_FOLDER_ID",
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
    const message =
      typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 8000)
      return json(res, 400, { error: "Некорректный текст запроса" });

    const user = auth.currentUser(req)!,
      canPropose = auth.canEdit(req);
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

    const usageRun = usage.begin(user.id, runtime.model),
      metrics: ResearchMetrics = {
        providerCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
      },
      controller = new AbortController();
    if (stream)
      res.on("close", () => {
        if (!res.writableEnded) controller.abort();
      });

    if (stream) {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders?.();
      sse(res, "status", { message: "Соединение установлено" });
    }

    try {
      const result = await runResearch({
        body,
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
      });
      usage.finish(usageRun.id, usageRun.started, {
        status: "ok",
        providerCalls: metrics.providerCalls,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
      });

      if (stream) {
        sse(res, "done", {
          answer: result.answer,
          references: result.references,
        });
        res.end();
        return true;
      }
      return json(res, 200, result);
    } catch (error) {
      usage.finish(usageRun.id, usageRun.started, {
        status: "error",
        providerCalls: metrics.providerCalls,
        inputTokens: metrics.inputTokens,
        outputTokens: metrics.outputTokens,
      });
      if (stream) {
        sse(res, "error", {
          error:
            error instanceof Error
              ? error.message
              : "Не удалось получить ответ ИИ",
        });
        res.end();
        return true;
      }
      return json(res, error instanceof RangeError ? 400 : 502, {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось получить ответ ИИ",
      });
    }
  };
}
