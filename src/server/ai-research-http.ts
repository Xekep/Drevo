import type { IncomingMessage, ServerResponse } from "node:http";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { isSameOriginRequest } from "./same-origin.ts";
import { isScopedUser, projectFamilyForUser } from "../domain/tree-access.ts";
import {
  executeResearchTool,
  RESEARCH_TOOL_DEFINITIONS,
} from "../domain/research-tools.ts";

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

export function aiResearchHttp({
  archive,
  auth,
  publicOrigin,
  fetcher = fetch,
}: {
  archive: ReturnType<typeof openArchive>;
  auth: ReturnType<typeof createAuth>;
  publicOrigin?: string;
  fetcher?: typeof fetch;
}) {
  const apiKey = process.env.YANDEX_AI_API_KEY?.trim(),
    model = process.env.YANDEX_AI_MODEL?.trim(),
    baseUrl = (
      process.env.YANDEX_AI_BASE_URL || "https://ai.api.cloud.yandex.net/v1"
    ).replace(/\/$/, "");
  const enabled = !!apiKey && !!model;
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(value));
    return true;
  };

  async function complete(messages: ModelMessage[]): Promise<ModelMessage> {
    const response = await fetcher(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "Content-Type": "application/json",
        ...(folderId ? { "OpenAI-Project": folderId } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        tool_choice: "auto",
        tools: RESEARCH_TOOL_DEFINITIONS.map((definition) => ({
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
      return json(res, 200, { enabled });
    }

    if (req.method !== "POST")
      return json(res, 405, { error: "Ожидается POST" });
    if (!isSameOriginRequest(req, publicOrigin))
      return json(res, 403, { error: "Invalid origin" });
    if (!enabled)
      return json(res, 503, {
        error:
          "ИИ-исследователь не настроен: задайте YANDEX_AI_API_KEY и YANDEX_AI_FOLDER_ID",
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
        fullFamily = archive.read().family,
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
      ];

      for (let round = 0; round < 8; round++) {
        const answer = await complete(messages);
        messages.push(answer);
        const calls = answer.tool_calls || [];
        if (!calls.length)
          return json(res, 200, {
            answer:
              typeof answer.content === "string" && answer.content.trim()
                ? answer.content
                : "Модель не сформировала текстовый ответ.",
          });

        for (const call of calls) {
          const definition = RESEARCH_TOOL_DEFINITIONS.find(
            (item) => item.name === call.function.name,
          );
          let result: unknown;
          try {
            if (!definition)
              throw new Error("Модель запросила неизвестный инструмент");
            result = executeResearchTool(
              family,
              definition.name,
              JSON.parse(call.function.arguments || "{}"),
            );
          } catch (error) {
            result = {
              error:
                error instanceof Error
                  ? error.message
                  : "Ошибка исследовательского инструмента",
            };
          }
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
