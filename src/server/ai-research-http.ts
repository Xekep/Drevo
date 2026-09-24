import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { createAuth } from "./auth.ts";
import type { openArchive } from "./database.ts";
import { aiRuntimeConfig, type aiSettingsStore } from "./ai-settings.ts";
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
import { AiLimitError, type aiUsageStore } from "./ai-usage.ts";
import type { ArchiveUser } from "../domain/access.ts";
import type { Family } from "../domain/types.ts";
import type { mediaStore } from "./media.ts";
import type { imagePreviews } from "./image-previews.ts";
import { fetchAiStudioModels } from "./ai-models.ts";
import { researchPdf, type ResearchGraph } from "./research-pdf.ts";

type ToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};
type ModelMessage = {
  role: string;
  content?:
    | string
    | null
    | Array<
        | { type: "text"; text: string }
        | {
            type: "image_url";
            image_url: { url: string };
          }
      >;
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

export function requesterPromptContext(user: ArchiveUser, family: Family) {
  if (!user.personId) return "";
  const person = family.people.find(
    (candidate) => candidate.id === user.personId,
  );
  if (!person) return "";
  return `Сейчас к тебе обращается ${fullName(person)} (personId: ${person.id}) — этот человек привязан к текущему аккаунту. Слова «я», «мои родственники», «мои предки» и подобные формулировки относятся к нему.`;
}

export function requesterAccessContext(user: ArchiveUser, canPropose: boolean) {
  const readScope =
    user.role !== "admin" && user.treeAccess === "common_ancestors"
      ? "Пользователь видит только людей из области общих предков и связанные с ними фотографии. Скрытых данных в инструментах нет; не предполагай их существование и не пытайся их раскрыть."
      : "Пользователю доступен весь семейный архив.";
  if (!canPropose)
    return `${readScope} Доступ только для чтения: не предлагай сохранить, создать или изменить данные.`;
  if (user.role === "admin")
    return `${readScope} Пользователь может подтверждать изменения любых объектов архива.`;
  return `${readScope} Пользователь может создавать новые карточки, но редактировать и связывать только созданные им объекты. Сервер отдельно проверяет право на каждое предложение.`;
}
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
  | { kind: "photo"; id: string; label: string }
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
  suggestionIds: string[];
  uiActions: UiAction[];
  files: ResearchFile[];
};

type ResearchFile = { name: string; url: string };

const CREATE_PDF_TOOL = {
  name: "create_pdf",
  description:
    "Создать PDF из подготовленного текста по явной просьбе пользователя. Передай заголовок и проверенное содержимое; файл будет приложен к ответу автоматически. Для анализа архива и при просьбе о графе сервер добавит страницу с нарисованной схемой из реальных данных архива. Не помещай в документ данные, которые не доступны пользователю.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 160 },
      content: { type: "string", minLength: 1, maxLength: 30000 },
    },
    required: ["title", "content"],
    additionalProperties: false,
  },
} as const;

type UiAction =
  | { type: "focus_people"; personIds: string[] }
  | { type: "open_person"; personId: string }
  | { type: "open_photo"; photoId: string };

const ANALYZE_PHOTO_TOOL = {
  name: "analyze_photo",
  description:
    "Передать доступную фотографию модели для визуального анализа. Сначала найди photoId через search_photos или get_photo. Описывай только видимое, не устанавливай личности неизвестных людей по лицу и отделяй наблюдения от гипотез.",
  inputSchema: {
    type: "object",
    properties: {
      photoId: { type: "string", minLength: 1, maxLength: 200 },
      question: { type: "string", maxLength: 2000 },
    },
    required: ["photoId"],
    additionalProperties: false,
  },
} as const;

const CONTROL_VIEW_TOOL = {
  name: "control_archive_view",
  description:
    "Управлять текущим интерфейсом только по явной просьбе пользователя. action=focus_people плавно перемещает древо к одному человеку либо показывает и подсвечивает цепочку между несколькими людьми; action=open_person открывает карточку; action=open_photo открывает фотографию. Если просят переместить, провести, найти или показать человека на древе, после search_people обязательно вызови focus_people. Не вызывай инструмент только потому, что упомянул запись в ответе.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["focus_people", "open_person", "open_photo"],
      },
      personIds: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 200 },
        minItems: 1,
        maxItems: 20,
      },
      personId: { type: "string", minLength: 1, maxLength: 200 },
      photoId: { type: "string", minLength: 1, maxLength: 200 },
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;

export function explicitViewControlRequest(message: string, view = "") {
  const directInterfaceRequest =
      /(?:покаж(?:и|ь)?|перейди|открой|приблиз|сфокус|выдел|подсвет|проведи|перемест|перенес|центрир|навед|найди).{0,60}(?:древ|дерев|карточ|фото|сним|люд|человек|цепоч|связ|ветк)|(?:на древе|в дереве|на карте).{0,60}(?:покаж(?:и|ь)?|найди|выдел|подсвет|перемест|центрир)/iu.test(
        message,
      ),
    treeMovementRequest =
      view === "tree" &&
      /(?:перемест|перенес|проведи|перейди|навед|центрир).{0,40}(?:меня|к|на|до)/iu.test(
        message,
      );
  return directInterfaceRequest || treeMovementRequest;
}

export function recoverTextToolCalls(
  content: string,
  allowedNames: ReadonlySet<string>,
): ToolCall[] {
  const fenced = [...content.matchAll(/```[^\r\n]*\r?\n([\s\S]*?)```/g)],
    candidates = fenced.length ? fenced.map((match) => match[1]) : [content];
  if (candidates.length > 6) return [];
  const calls: ToolCall[] = [];
  for (const [index, candidate] of candidates.entries()) {
    try {
      const match = candidate
        .trim()
        .match(/^([a-z][a-z0-9_]*)\s*\(\s*([\s\S]*?)\s*\)\s*;?$/i);
      const split = candidate
        .trim()
        .match(/^([a-z][a-z0-9_]*)\s*\r?\n\s*(\{[\s\S]*\})\s*$/i);
      const parsed = match
        ? { name: match[1], parameters: JSON.parse(match[2]) }
        : split
          ? { name: split[1], parameters: JSON.parse(split[2]) }
          : JSON.parse(candidate.trim());
      if (
        !parsed ||
        typeof parsed !== "object" ||
        Array.isArray(parsed) ||
        typeof parsed.name !== "string" ||
        !allowedNames.has(parsed.name) ||
        !parsed.parameters ||
        typeof parsed.parameters !== "object" ||
        Array.isArray(parsed.parameters)
      )
        return [];
      calls.push({
        id: `recovered-tool-${index}`,
        type: "function",
        function: {
          name: parsed.name,
          arguments: JSON.stringify(parsed.parameters),
        },
      });
    } catch {
      return [];
    }
  }
  return calls;
}

function containsInternalToolText(
  content: string,
  allowedNames: ReadonlySet<string>,
) {
  if (
    /["']name["']\s*:\s*["'][a-z][a-z0-9_]*["']\s*,\s*["']parameters["']\s*:/i.test(
      content,
    ) ||
    /\b(?:get|find|search|list|propose|control)_[a-z0-9_]+\s*\(\s*\{/i.test(
      content,
    )
  )
    return true;
  return [...allowedNames].some((name) =>
    new RegExp(
      `\\b${name}\\s*(?:\\(|\\r?\\n\\s*\\{)|["']name["']\\s*:\\s*["']${name}["']`,
      "i",
    ).test(content),
  );
}

function archiveGraph(family: Family): ResearchGraph {
  const ids = new Set(family.people.map((person) => person.id));
  const spouses = new Set<string>();
  const edges: ResearchGraph["edges"] = [];
  for (const person of family.people) {
    for (const parentId of person.parents)
      if (ids.has(parentId))
        edges.push({ from: parentId, to: person.id, type: "parent" });
    for (const spouseId of person.spouses)
      if (ids.has(spouseId)) {
        const [from, to] = [person.id, spouseId].sort(),
          key = `${from}\0${to}`;
        if (!spouses.has(key)) {
          spouses.add(key);
          edges.push({ from, to, type: "spouse" });
        }
      }
  }
  for (const link of family.links || [])
    if (ids.has(link.from) && ids.has(link.to))
      edges.push({ from: link.from, to: link.to, type: link.type });
  return {
    nodes: family.people.map((person) => ({
      id: person.id,
      name: fullName(person),
      birth: person.birth,
      death: person.death,
    })),
    edges,
  };
}

function researchToolStatus(name: string) {
  const labels: Record<string, string> = {
    get_archive_insights: "Собираю статистику и факты архива…",
    find_missing_data: "Ищу пробелы в карточках людей…",
    find_inconsistencies: "Проверяю противоречия в данных…",
    find_possible_duplicates: "Проверяю похожие карточки…",
    get_research_backlog: "Составляю дальнейшие шаги исследования…",
    get_genealogy_graph: "Строю схему родственных связей…",
    search_people: "Ищу людей в архиве…",
    list_people: "Составляю список людей…",
    get_sources: "Изучаю указанные источники…",
    analyze_photo: "Изучаю фотографию…",
    create_pdf: "Готовлю PDF и приложения…",
  };
  return labels[name] || "Проверяю связанные сведения в архиве…";
}

export function humanizeResearchAnswer(
  answer: string,
  people: Map<string, string>,
  photos: Map<string, string>,
) {
  const labels = [...people, ...photos].sort(
    ([left], [right]) => right.length - left.length,
  );
  return answer
    .split(/(\[\[(?:person|choose-person|photo):[^\]]+\]\]|```[\s\S]*?```)/g)
    .map((segment, index) => {
      if (index % 2) return segment;
      let text = segment.replace(
        /\s*\(\s*(?:personId|photoId)\s*:\s*[^)]+\)/giu,
        "",
      );
      text = text.replace(/\b(?:personId|photoId)\s*[:=]\s*[^\s,;]+/giu, "");
      for (const [id, label] of labels)
        if (id && text.includes(id))
          text = text.replaceAll(
            new RegExp(
              `(?<![\\p{L}\\p{N}_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`,
              "gu",
            ),
            () => label,
          );
      return text;
    })
    .join("");
}

function needsArchiveLookupRetry(request: string, answer: string) {
  const archiveQuestion =
      /(?:брат|сестр|двоюрод|троюрод|четвероюрод|пятиюрод|шестиюрод|семиюрод|восьмиюрод|девятиюрод|десятиюрод|родител|мат(?:ь|ери)|отец|отца|мам|пап|сын|доч|дет|супруг|муж|жен|родств|предк|потом|родил|умер|жил|фото|сним|источник|архив|древ|анализ|противореч|статист|пробел|неточност|дубл|сводк)/iu.test(
        request,
      ),
    unverifiedAbsence =
      /(?:в архиве|в базе).{0,40}(?:нет|не найден)|не удалось найти.{0,40}(?:человек|люд|данн)|нет данных/iu.test(
        answer,
      );
  return archiveQuestion || unverifiedAbsence;
}

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

function commonPrefixLength(left: string, right: string) {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  )
    index++;
  return index;
}

function repairArchiveMarkers(
  value: string,
  people: Map<string, string>,
  photos: Map<string, string>,
  referencedPeople: Set<string>,
  referencedPhotos: Set<string>,
) {
  return value.replace(
    /\[\[(person|choose-person|photo):([^|\]\s]+)\|([^\]]+)\]\]/g,
    (marker, kind: string, id: string, label: string) => {
      const records = kind === "photo" ? photos : people,
        referenced = kind === "photo" ? referencedPhotos : referencedPeople;
      if (records.has(id)) return marker;
      const normalizedLabel = label.trim().toLocaleLowerCase("ru"),
        candidates = [...referenced],
        exact = candidates.filter(
          (candidate) =>
            records.get(candidate)?.trim().toLocaleLowerCase("ru") ===
            normalizedLabel,
        ),
        pool = exact.length ? exact : candidates,
        closest = pool
          .map((candidate) => ({
            id: candidate,
            score: commonPrefixLength(id, candidate),
          }))
          .sort((left, right) => right.score - left.score)[0];
      const repaired =
        exact.length === 1
          ? exact[0]
          : closest && closest.score >= 8
            ? closest.id
            : "";
      return repaired ? `[[${kind}:${repaired}|${label}]]` : label;
    },
  );
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
  media,
  previewImage,
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
  publicOrigin?: string;
  fetcher?: typeof fetch;
}) {
  const pdfFiles = new Map<
    string,
    { ownerId: string; name: string; bytes: Buffer; expires: number }
  >();
  let visionModelCache:
    { key: string; modelUri: string; expiresAt: number } | undefined;
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
      ANALYZE_PHOTO_TOOL,
      CONTROL_VIEW_TOOL,
      CREATE_PDF_TOOL,
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

  async function visionModelUri(runtime: ReturnType<typeof aiRuntimeConfig>) {
    const folderId =
        runtime.folderId ||
        /^gpt:\/\/([^/]+)/.exec(runtime.modelUri)?.[1] ||
        "",
      key = `${runtime.baseUrl}\0${folderId}`;
    if (
      visionModelCache?.key === key &&
      visionModelCache.expiresAt > Date.now()
    )
      return visionModelCache.modelUri;
    const current = runtime.modelUri.replace(/^gpt:\/\/[^/]+\//, "");
    if (/^qwen3\.6-35b-a3b(?:\/latest)?$/.test(current))
      return runtime.modelUri;
    const models = await fetchAiStudioModels({
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        folderId,
        fetcher,
      }),
      selected = models.find((model) => model.label === "qwen3.6-35b-a3b");
    if (!selected)
      throw new Error(
        "В этом Folder ID нет модели Qwen3.6-35B для анализа фотографий",
      );
    visionModelCache = {
      key,
      modelUri: selected.id,
      expiresAt: Date.now() + 5 * 60_000,
    };
    return selected.id;
  }

  async function analyzeImage(
    question: string,
    dataUrl: string,
    runtime: ReturnType<typeof aiRuntimeConfig>,
  ) {
    const body = {
        model: await visionModelUri(runtime),
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.2,
      },
      response = await fetcher(`${runtime.baseUrl}/chat/completions`, {
        method: "POST",
        headers: providerHeaders(runtime),
        body: JSON.stringify(body),
      }),
      data = (await response.json()) as ModelResponse;
    if (!response.ok)
      throw new Error(
        data.error?.message ||
          `Модель анализа фотографий вернула HTTP ${response.status}`,
      );
    const message = data.choices?.[0]?.message,
      content =
        typeof message?.content === "string" ? message.content.trim() : "";
    if (!content)
      throw new Error("Модель анализа фотографий не вернула описание");
    const reported = usageTokens(data.usage);
    return {
      content,
      inputTokens: reported.input ?? estimateTokens(body),
      outputTokens: reported.output ?? estimateTokens(message),
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
        {
          id: string;
          type?: string;
          function: { name: string; arguments: string };
        }
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
    const message = typeof body.message === "string" ? body.message.trim() : "";
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
      history = validHistory(body.history),
      lookupContext = [
        ...history
          .filter((item) => item.role === "user")
          .slice(-2)
          .map((item) => String(item.content || "")),
        message,
      ].join("\n"),
      system = [
        "Ты исследователь семейного архива Drevo.",
        "Опирайся только на данные инструментов и слова пользователя.",
        "Не превращай предположение в факт. Явно разделяй подтверждённые сведения, вычисляемые противоречия и гипотезы для дальнейшего поиска.",
        "Если для ответа нужны данные архива, вызывай инструменты вместо догадок.",
        "Для обзора архива используй get_archive_insights; для пробелов, противоречий и возможных дублей — find_missing_data, find_inconsistencies и find_possible_duplicates по смыслу вопроса. Если спрашивают, что делать дальше, используй get_research_backlog и предложи конкретные шаги. Укажи, какие выводы подтверждены данными, а какие требуют проверки источников.",
        "Если пользователь называет человека по имени, фамилии или их части, всегда сначала вызывай search_people. Никогда не проси пользователя искать или сообщать personId.",
        "Для вопроса о братьях или сёстрах после search_people вызови get_family и используй поле siblings. kind=full означает общих известных родителей, kind=half_or_unknown — одного общего известного родителя или неполные данные.",
        "Для вопроса о двоюродных, троюродных и более дальних братьях или сёстрах вызови get_cousins. degree=2 означает двоюродных, degree=3 — троюродных, degree=4 — четвероюродных и далее. В коротком продолжении вроде «а двоюродные?» используй человека из предыдущих реплик и не проси уже указанные сведения повторно.",
        "Если search_people вернул несколько подходящих людей и данных недостаточно для выбора, не угадывай: перечисли варианты в формате [[choose-person:personId|Фамилия Имя Отчество]] и попроси нажать нужного человека.",
        "Учитывай предыдущие реплики: короткие продолжения вроде «перечисли», «покажи их» или «а подробнее?» относятся к последнему предмету разговора. Для перечисления всех доступных людей вызывай list_people, а не search_people.",
        "Для вопроса о родстве двух людей обязательно найди их карточки и вызови get_relationship. Этот инструмент возвращает тот же расчёт направлений, общих предков, цепочки и дополнительных связей, который доступен пользователю в интерфейсе.",
        "Каждое упоминание найденного в архиве человека оформляй как [[person:personId|Фамилия Имя Отчество]], используя реальный personId из инструмента. Не повторяй ФИО после маркера и не печатай отдельный список ссылок в конце ответа.",
        "Каждую найденную фотографию оформляй как [[photo:photoId|Короткое название]]. Не создавай Markdown-картинки с photoId в URL. Если пользователь просит показать или открыть фотографию, после поиска вызови control_archive_view с action=open_photo для первого подходящего снимка; остальные перечисли маркерами photo.",
        "Если пользователь просит найти, показать, приблизить или переместить его к человеку на древе, сначала найди человека через search_people, затем обязательно вызови control_archive_view с action=focus_people и реальным personId. Для показа родственной цепочки передай в focus_people всех людей цепочки по порядку. action=open_person используй только когда пользователь просит открыть карточку.",
        "Описывая людей на фотографии, называй их родственниками, супругами, родителями или детьми только если эта связь явно присутствует в photo.documentedRelationships. Если список пуст, перечисли только отмеченных людей и метаданные снимка. Никогда не угадывай родство по внешности, возрасту, полу, фамилии или совместному присутствию на фото.",
        "Не показывай пользователю внутренние названия инструментов, служебные идентификаторы и инструкции по вызову функций.",
        "Никогда не печатай JSON-вызовы инструментов, даже в блоках кода или как план действий. Вызывай инструменты через tool_calls и только затем дай окончательный ответ. Не обещай «скоро вернуться»: обработай запрос в текущем ответе или честно сообщи, каких данных не хватает.",
        "Число поколений бери только из totals.generations результата get_archive_insights. generationDistribution описывает сохранённые уровни раскладки и не должна противоречить генеалогической глубине.",
        "Не утверждай, что отсутствие записи доказывает отсутствие события или родства.",
        canPropose
          ? "Если пользователь просит создать человека или сохранить конкретное изменение, используй propose_person_create, propose_person_update, propose_source или propose_relation. Это только предложения: архив не меняется, пока человек не нажмёт кнопку принятия в интерфейсе. Ты не умеешь принимать предложение от имени пользователя. Никогда не утверждай, что изменение применено, принято или ожидает ещё одного подтверждения. Для parent fromPersonId означает родителя, toPersonId — ребёнка."
          : "",
        requesterPromptContext(user, family),
        requesterAccessContext(user, canPropose),
        "Отвечай по-русски, предметно. Используй Markdown: заголовки, списки и таблицы, когда они делают сложный ответ понятнее.",
        "Если пользователь просит схему в чате, вызови get_genealogy_graph и вставь возвращённое поле mermaid в fenced-блок ```mermaid без изменений. Не добавляй отсутствующие в edges связи. Внутри Mermaid не используй Markdown, ссылки и маркеры [[person:...]].",
        "Если пользователь просит PDF, сначала собери необходимые сведения доступными инструментами, затем обязательно вызови create_pdf через tool_calls с заголовком и подготовленным текстом. При просьбе о графе связей в PDF сервер сам добавляет отдельную страницу с нарисованной схемой реальных связей архива. В обычном ответе кратко поясни содержимое файла; не печатай URL, ссылка на скачивание появится автоматически. Не обещай готовый файл, пока инструмент не вернул created: true.",
        personIds.length
          ? `Сейчас в интерфейсе выбраны люди: ${personIds.join(", ")}.`
          : "",
        view ? `Текущий раздел интерфейса: ${view}.` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      messages: ModelMessage[] = [
        { role: "system", content: system },
        ...history,
        { role: "user", content: message },
      ],
      peopleById = new Map(
        family.people.map((person) => [person.id, fullName(person)]),
      ),
      photosById = new Map(
        (family.photos || []).map((photo) => [
          photo.id,
          photo.title.trim() || `Фотография ${photo.id}`,
        ]),
      ),
      referencedPeople = new Set<string>(),
      referencedPhotos = new Set<string>(),
      referencedSources = new Map<
        string,
        Extract<AnswerReference, { kind: "source" }>
      >(),
      createdSuggestionIds = new Set<string>(),
      proposalErrors: string[] = [];
    let analyzedPhotos = 0,
      executedTools = 0,
      lookupRetryUsed = false,
      internalOutputRetryUsed = false,
      pdfRetryUsed = false;
    const uiActions: UiAction[] = [],
      files: ResearchFile[] = [],
      allowedToolNames = new Set([
        ...RESEARCH_TOOL_DEFINITIONS.map((tool) => tool.name),
        ANALYZE_PHOTO_TOOL.name,
        CONTROL_VIEW_TOOL.name,
        CREATE_PDF_TOOL.name,
        ...(canPropose ? RESEARCH_PROPOSAL_TOOLS.map((tool) => tool.name) : []),
      ]),
      viewControlRequested = explicitViewControlRequest(message, view),
      photoViewRequested =
        /(?:покаж(?:и|ь)?|открой).{0,40}(?:фото|сним)|(?:фото|сним).{0,40}(?:покаж(?:и|ь)?|открой)/iu.test(
          message,
        ),
      personCardViewRequested =
        /(?:открой|покаж(?:и|ь)?).{0,40}карточ|карточ.{0,40}(?:открой|покаж(?:и|ь)?)/iu.test(
          message,
        ),
      pdfRequested =
        /(?:pdf|пдф)/iu.test(message) ||
        /(?:сдела|созда|сформир|подготов|дай|гони|пришл|скача).{0,45}(?:файл|документ)|(?:файл|документ).{0,35}(?:готов|скача|пришл)|(?:в документе|в файле).{0,70}(?:граф|схем)/iu.test(
          message,
        ),
      graphInPdfRequested =
        pdfRequested &&
        family.people.length > 0 &&
        /(?:граф|схем|анализ)/iu.test(lookupContext);

    if (
      canPropose &&
      /^(?:да[,!. ]*|подтверждаю|согласен|согласна|принять|прими)$/iu.test(
        message,
      )
    ) {
      const pending = suggestions.list(user).slice(0, 8);
      if (pending.length)
        return {
          answer:
            "Для применения используйте кнопки ✓ или × у предложения ниже. Текстовое подтверждение не изменяет архив.",
          references: [],
          suggestionIds: pending.map((suggestion) => suggestion.id),
          uiActions: [],
          files: [],
        };
    }

    onStatus("Обрабатываю запрос…");

    for (let round = 0; round < 12; round++) {
      metrics.providerCalls++;
      const completion = stream
          ? await completeStream(messages, canPropose, runtime, signal)
          : await complete(messages, canPropose, runtime),
        answer = completion.message;
      metrics.inputTokens += completion.inputTokens;
      metrics.outputTokens += completion.outputTokens;
      if (
        !answer.tool_calls?.length &&
        typeof answer.content === "string" &&
        answer.content.trim()
      ) {
        const recovered = recoverTextToolCalls(
          answer.content,
          allowedToolNames,
        ).map((call, index) => ({
          ...call,
          id: `recovered-tool-${round}-${index}`,
        }));
        if (recovered.length) {
          answer.content = null;
          answer.tool_calls = recovered;
        }
      }
      messages.push(answer);

      const calls = answer.tool_calls || [];
      if (!calls.length) {
        const rawContent =
          typeof answer.content === "string" ? answer.content : "";
        if (
          containsInternalToolText(rawContent, allowedToolNames) &&
          !internalOutputRetryUsed
        ) {
          internalOutputRetryUsed = true;
          messages.push({
            role: "system",
            content:
              "В предыдущем тексте оказалась внутренняя команда или JSON-вызов. Не показывай их пользователю. Вызови нужный инструмент структурированно через tool_calls, затем дай завершённый проверенный ответ обычным языком без ID и обещаний вернуться позже.",
          });
          onStatus("Уточняю ответ по данным архива…");
          continue;
        }
        if (pdfRequested && !files.length && !pdfRetryUsed) {
          pdfRetryUsed = true;
          messages.push({
            role: "system",
            content:
              "Пользователь просит PDF, но файл ещё не создан. Вызови create_pdf именно через tool_calls. Если не можешь создать файл, прямо объясни причину и не утверждай, что он приложен.",
          });
          onStatus("Создаю запрошенный PDF…");
          continue;
        }
        if (
          !lookupRetryUsed &&
          executedTools === 0 &&
          needsArchiveLookupRetry(
            lookupContext,
            typeof answer.content === "string" ? answer.content : "",
          )
        ) {
          lookupRetryUsed = true;
          messages.push({
            role: "system",
            content:
              "Предыдущий ответ не был проверен по архиву. Не повторяй его и не делай вывод об отсутствии данных. Сейчас обязательно вызови подходящий инструмент; если назван человек, начни с search_people, учитывая полное имя и разговорные формы имени из контекста.",
          });
          onStatus("Уточняю данные в архиве…");
          continue;
        }
        if (
          photoViewRequested &&
          !uiActions.some((action) => action.type === "open_photo")
        ) {
          const photoId = referencedPhotos.values().next().value;
          if (photoId) uiActions.push({ type: "open_photo", photoId });
        }
        if (
          viewControlRequested &&
          !photoViewRequested &&
          !uiActions.some(
            (action) =>
              action.type === "focus_people" || action.type === "open_person",
          )
        ) {
          const personIds = [...referencedPeople].slice(0, 20);
          if (personIds.length)
            uiActions.push(
              personCardViewRequested
                ? { type: "open_person", personId: personIds[0] }
                : { type: "focus_people", personIds },
            );
        }
        const references: AnswerReference[] = [
          ...[...referencedPeople].slice(0, 12).map((id) => ({
            kind: "person" as const,
            id,
            label: peopleById.get(id)!,
          })),
          ...[...referencedSources.values()].slice(0, 8),
          ...[...referencedPhotos].slice(0, 8).map((id) => ({
            kind: "photo" as const,
            id,
            label: photosById.get(id)!,
          })),
        ];
        const rawAnswer =
          pdfRequested && !files.length
            ? "Не удалось создать PDF. Попробуйте повторить запрос."
            : createdSuggestionIds.size
              ? createdSuggestionIds.size === 1
                ? "Подготовлено предложение. Проверьте данные ниже и нажмите ✓, чтобы применить изменение, или ×, чтобы отклонить."
                : "Подготовлены предложения. Проверьте данные ниже и примите или отклоните каждое кнопками ✓ и ×."
              : proposalErrors.length
                ? `Не удалось подготовить предложение: ${[...new Set(proposalErrors)].join("; ")}. Архив не изменён.`
                : typeof answer.content === "string" && answer.content.trim()
                  ? answer.content
                  : "Модель не сформировала текстовый ответ.";
        const safeAnswer = containsInternalToolText(rawAnswer, allowedToolNames)
          ? "Не удалось сформулировать ответ по данным архива. Попробуйте уточнить вопрос."
          : humanizeResearchAnswer(
              repairArchiveMarkers(
                files.length
                  ? rawAnswer.replace(
                      /(?:Скачать файл можно по ссылке:|Ссылка:)\s*(?=(?:\[[^\]]+\]\()?\s*(?:https?:\/\/[^\s)]*)?\/api\/ai\/files\/)|\[[^\]]+\]\((?:https?:\/\/[^\s)]*)?\/api\/ai\/files\/[a-f\d-]+\)|(?:https?:\/\/[^\s)]*)?\/api\/ai\/files\/[a-f\d-]+/giu,
                      "",
                    )
                  : rawAnswer,
                peopleById,
                photosById,
                referencedPeople,
                referencedPhotos,
              ),
              peopleById,
              photosById,
            );
        onDelta(safeAnswer);
        return {
          answer: safeAnswer,
          references,
          suggestionIds: [...createdSuggestionIds],
          uiActions,
          files,
        };
      }

      for (const call of calls) {
        executedTools++;
        onStatus(researchToolStatus(call.function.name));
        const definition = RESEARCH_TOOL_DEFINITIONS.find(
          (item) => item.name === call.function.name,
        );
        let result: unknown,
          toolArgs: unknown = {};
        try {
          toolArgs = JSON.parse(call.function.arguments || "{}");
          if (definition)
            result = executeResearchTool(family, definition.name, toolArgs);
          else if (call.function.name === CREATE_PDF_TOOL.name) {
            if (!pdfRequested)
              throw new Error("PDF создаётся только по просьбе пользователя");
            if (files.length >= 3)
              throw new Error("За один запрос можно создать не более трёх PDF");
            const raw = toolArgs as Record<string, unknown>,
              title = typeof raw.title === "string" ? raw.title.trim() : "",
              content =
                typeof raw.content === "string" ? raw.content.trim() : "",
              bytes = await researchPdf(
                title,
                content,
                graphInPdfRequested ? archiveGraph(family) : undefined,
              ),
              id = randomUUID(),
              name = `${
                title
                  .replace(/[\\/:*?"<>|]/g, " ")
                  .trim()
                  .slice(0, 80) || "Исследование"
              }.pdf`,
              url = `/api/ai/files/${id}`;
            for (const [key, item] of pdfFiles)
              if (item.expires < Date.now()) pdfFiles.delete(key);
            pdfFiles.set(id, {
              ownerId: user.id,
              name,
              bytes,
              expires: Date.now() + 30 * 60_000,
            });
            files.push({ name, url });
            result = { created: true, file: { name, url } };
          } else if (call.function.name === ANALYZE_PHOTO_TOOL.name) {
            if (analyzedPhotos >= 3)
              throw new Error(
                "За один ответ можно проанализировать не более трёх фотографий",
              );
            const raw = toolArgs as Record<string, unknown>,
              photoId =
                typeof raw.photoId === "string" ? raw.photoId.trim() : "",
              question =
                typeof raw.question === "string" && raw.question.trim()
                  ? raw.question.trim().slice(0, 2000)
                  : "Опиши фотографию и отметь детали, полезные для семейного архива.";
            if (!photoId || !photosById.has(photoId))
              throw new Error("Фотография не найдена или недоступна");
            const photo = (family.photos || []).find(
                (item) => item.id === photoId,
              )!,
              source = media.open(photo.url);
            if (!source) throw new Error("Файл фотографии недоступен");
            const bytes = await previewImage(
              { path: source.path, cacheKey: source.name },
              "ai",
            );
            metrics.providerCalls++;
            const visual = await analyzeImage(
              question,
              `data:image/jpeg;base64,${bytes.toString("base64")}`,
              runtime,
            );
            analyzedPhotos++;
            metrics.inputTokens += visual.inputTokens;
            metrics.outputTokens += visual.outputTokens;
            result = {
              ...executeResearchTool(family, "get_photo", { photoId }),
              visualAnalysis: visual.content,
            };
          } else if (call.function.name === CONTROL_VIEW_TOOL.name) {
            if (!viewControlRequested)
              throw new Error(
                "Пользователь явно не просил менять текущий экран",
              );
            const raw = toolArgs as Record<string, unknown>;
            if (raw.action === "focus_people") {
              const personIds = Array.isArray(raw.personIds)
                ? raw.personIds.filter(
                    (id): id is string =>
                      typeof id === "string" && peopleById.has(id),
                  )
                : [];
              if (!personIds.length)
                throw new Error("Не указаны доступные люди для показа");
              const action: UiAction = {
                type: "focus_people",
                personIds: [...new Set(personIds)].slice(0, 20),
              };
              uiActions.push(action);
              result = { scheduled: true, action };
            } else if (
              raw.action === "open_person" &&
              typeof raw.personId === "string" &&
              peopleById.has(raw.personId)
            ) {
              const action: UiAction = {
                type: "open_person",
                personId: raw.personId,
              };
              uiActions.push(action);
              result = { scheduled: true, action };
            } else if (
              raw.action === "open_photo" &&
              typeof raw.photoId === "string" &&
              photosById.has(raw.photoId)
            ) {
              const action: UiAction = {
                type: "open_photo",
                photoId: raw.photoId,
              };
              uiActions.push(action);
              result = { scheduled: true, action };
            } else
              throw new Error("Запрошенный объект не найден или недоступен");
          } else if (
            canPropose &&
            RESEARCH_PROPOSAL_TOOLS.some(
              (tool) => tool.name === call.function.name,
            )
          ) {
            const suggestion = suggestions.createFromTool(
              call.function.name,
              user,
              family,
              snapshot.revision,
              toolArgs,
            );
            createdSuggestionIds.add(suggestion.id);
            result = { suggestion };
          } else throw new Error("Модель запросила неизвестный инструмент");
        } catch (error) {
          if (
            RESEARCH_PROPOSAL_TOOLS.some(
              (tool) => tool.name === call.function.name,
            )
          )
            proposalErrors.push(
              error instanceof Error ? error.message : "Ошибка предложения",
            );
          result = {
            error:
              error instanceof Error
                ? error.message
                : "Ошибка исследовательского инструмента",
          };
        }
        if (call.function.name === CREATE_PDF_TOOL.name && files.length)
          onStatus(
            graphInPdfRequested ? "PDF со схемой связей готов" : "PDF готов",
          );
        collectPersonReferences(result, peopleById, referencedPeople);
        collectPersonReferences(result, photosById, referencedPhotos);
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
    const message = typeof body.message === "string" ? body.message.trim() : "";
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
          suggestionIds: result.suggestionIds,
          uiActions: result.uiActions,
          files: result.files,
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
