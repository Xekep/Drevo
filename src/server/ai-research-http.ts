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
type ModelResponse = {
  choices?: Array<{ message?: ModelMessage }>;
  error?: { message?: string };
};

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


type AnswerReference =
  | { kind: "person"; id: string; label: string }
  | {
      kind: "source";
      personId: string;
      label: string;
      reference?: string;
      url?: string;
    };

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

export function aiResearchHttp({
  archive,
  auth,
  suggestions,
  aiSettings,
  publicOrigin,
  fetcher = fetch,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  suggestions: ReturnType<typeof researchSuggestionStore>;
  aiSettings: ReturnType<typeof aiSettingsStore>;
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

  async function complete(
    messages: ModelMessage[],
    canPropose: boolean,
    runtime: ReturnType<typeof aiRuntimeConfig>,
  ): Promise<ModelMessage> {
    const definitions = [
      ...RESEARCH_TOOL_DEFINITIONS,
      ...(canPropose ? RESEARCH_PROPOSAL_TOOLS : []),
    ];
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
      }),
    });
    const data = (await response.json()) as ModelResponse;
    if (!response.ok)
      throw new Error(
        data.error?.message ||
          `Yandex AI Studio вернула HTTP ${response.status}`,
      );
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("Yandex AI Studio не вернула ответ");
    return message;
  }

  return async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> => {
    const path = url.pathname;
    if (path !== "/api/ai/status" && path !== "/api/ai/chat") return false;
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

    try {
      const body = (await readJson(req)) as Record<string, unknown>,
        message =
          typeof body.message === "string" ? body.message.trim() : "";
      if (!message || message.length > 8000)
        return json(res, 400, { error: "Некорректный текст запроса" });

      const user = auth.currentUser(req)!,
        canPropose = auth.canEdit(req),
        snapshot = archive.read(),
        fullFamily = snapshot.family,
        family = isScopedUser(user)
          ? projectFamilyForUser(fullFamily, user)
          : fullFamily,
        context =
          body.context && typeof body.context === "object"
            ? (body.context as Record<string, unknown>)
            : {};
      const personIds = Array.isArray(context.personIds)
        ? context.personIds
            .filter((id): id is string => typeof id === "string")
            .filter((id) => family.people.some((person) => person.id === id))
            .slice(0, 2)
        : [];
      const view = typeof context.view === "string" ? context.view : "";
      const system = [
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
        .join("\n");
      const messages: ModelMessage[] = [
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

      for (let round = 0; round < 8; round++) {
        const answer = await complete(messages, canPropose, runtime);
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
          return json(res, 200, {
            answer:
              typeof answer.content === "string" && answer.content.trim()
                ? answer.content
                : "Модель не сформировала текстовый ответ.",
            references,
          });
        }

        for (const call of calls) {
          const definition = RESEARCH_TOOL_DEFINITIONS.find(
            (item) => item.name === call.function.name,
          );
          let result: unknown,
            toolArgs: unknown = {};
          try {
            toolArgs = JSON.parse(call.function.arguments || "{}");
            if (definition)
              result = executeResearchTool(
                family,
                definition.name,
                toolArgs,
              );
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
      }
      return json(res, 502, {
        error: "ИИ превысил допустимое число вызовов инструментов",
      });
    } catch (error) {
      return json(res, error instanceof RangeError ? 413 : 502, {
        error:
          error instanceof Error
            ? error.message
            : "Не удалось получить ответ ИИ",
      });
    }
  };
}
