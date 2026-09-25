import type { IncomingMessage } from "node:http";
import type { ArchiveUser } from "../domain/access.ts";
import { fullName } from "../domain/dates.ts";
import type { Family } from "../domain/types.ts";
import { type ResearchGraph } from "./research-pdf.ts";

export type ToolCall = {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
};
export type ModelMessage = {
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
export type ModelUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens?: number;
  output_tokens?: number;
};
export type ModelResponse = {
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
export type AnswerReference =
  | { kind: "person"; id: string; label: string }
  | { kind: "photo"; id: string; label: string }
  | {
      kind: "source";
      personId: string;
      label: string;
      reference?: string;
      url?: string;
    };

export type ResearchMetrics = {
  providerCalls: number;
  agentIterations: number;
  compactionAvailable: boolean | null;
  toolCallCount: number;
  cachedTokens: number;
  responseId: string;
  inputTokens: number;
  outputTokens: number;
  models: Map<
    string,
    {
      providerCalls: number;
      inputTokens: number;
      outputTokens: number;
    }
  >;
};

export function recordModelCall(metrics: ResearchMetrics, model: string) {
  metrics.providerCalls++;
  const current = metrics.models.get(model) || {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  current.providerCalls++;
  metrics.models.set(model, current);
}

export function recordModelTokens(
  metrics: ResearchMetrics,
  model: string,
  inputTokens: number,
  outputTokens: number,
) {
  metrics.inputTokens += inputTokens;
  metrics.outputTokens += outputTokens;
  const current = metrics.models.get(model) || {
    providerCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  current.inputTokens += inputTokens;
  current.outputTokens += outputTokens;
  metrics.models.set(model, current);
}

export function modelUsage(metrics: ResearchMetrics) {
  return [...metrics.models].map(([model, usage]) => ({
    model,
    providerCalls: usage.providerCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
  }));
}

export type ResearchResult = {
  answer: string;
  references: AnswerReference[];
  suggestionIds: string[];
  uiActions: UiAction[];
  files: ResearchFile[];
};

export type ResearchFile = { name: string; url: string };

export const CREATE_PDF_TOOL = {
  name: "create_pdf",
  description:
    "Создать PDF из подготовленного Markdown по явной просьбе пользователя. Передай заголовок и проверенное содержимое с таблицами и графиками при необходимости. Поддерживаются блоки Mermaid graph/flowchart, pie и xychart; они будут нарисованы в PDF, а большая схема архива получит обзор и листы с деталями. Для анализа архива и при просьбе о графе сервер добавит схему из реальных данных. Не помещай в документ данные, которые не доступны пользователю.",
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

export type UiAction =
  | { type: "focus_people"; personIds: string[] }
  | { type: "filter_people"; personIds: string[]; label: string }
  | { type: "open_person"; personId: string }
  | { type: "open_photo"; photoId: string }
  | { type: "zoom_in" | "zoom_out" };

export const ANALYZE_PHOTO_TOOL = {
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

export const RESEARCH_RESOURCES_TOOL = {
  name: "find_research_resources",
  description:
    "Найти внешние сайты в редактируемом каталоге, в том числе по названию места и тексту описания. Передай поисковый запрос; категория необязательна. Результат содержит не более пяти ссылок. Ссылки не подтверждают факты архива.",
  inputSchema: {
    type: "object",
    properties: {
      category: { type: "string", minLength: 1, maxLength: 100 },
      query: { type: "string", maxLength: 200 },
    },
    required: ["query"],
    additionalProperties: false,
  },
} as const;

export function specificResourceRequest(message: string) {
  return (
    /(?:дай|покажи|найди|пришли|скинь|где)/iu.test(message) &&
    /(?:ссылк|сайт|ресурс|цифров.{0,30}кладбищ|онлайн.{0,30}кладбищ|каталог)/iu.test(
      message,
    )
  );
}

export function resourceMarkdown(resource: {
  name: string;
  url: string;
  description: string;
}) {
  const name = resource.name.replaceAll("[", "\\[").replaceAll("]", "\\]");
  const url = resource.url.replaceAll("(", "%28").replaceAll(")", "%29");
  return `- [${name}](${url}) — ${resource.description.replace(/\s*\n\s*/g, " ")}`;
}

export const CONTROL_VIEW_TOOL = {
  name: "control_archive_view",
  description:
    "Управлять интерфейсом только по явной просьбе пользователя. focus_people перемещает камеру; filter_surname показывает фамильную группу после get_surname_group; filter_people строит временное древо из проверенных personIds, собранных другими инструментами по произвольному критерию пользователя. open_person и open_photo открывают карточки; zoom_in и zoom_out меняют масштаб.",
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: [
          "focus_people",
          "filter_surname",
          "filter_people",
          "open_person",
          "open_photo",
          "zoom_in",
          "zoom_out",
        ],
      },
      personIds: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 200 },
        minItems: 1,
        maxItems: 300,
      },
      personId: { type: "string", minLength: 1, maxLength: 200 },
      photoId: { type: "string", minLength: 1, maxLength: 200 },
      surname: { type: "string", minLength: 2, maxLength: 100 },
      label: { type: "string", minLength: 1, maxLength: 100 },
    },
    required: ["action"],
    additionalProperties: false,
  },
} as const;

export function treeSubsetRequest(message: string) {
  return /(?:древ|дерев).{0,120}(?:только|остав|сформир|постро|из\s+(?:людей|родственник))|(?:только|остав|сформир|постро).{0,120}(?:древ|дерев)/iu.test(
    message,
  );
}

export function surnameInTreeRequest(message: string) {
  return (
    /(?:древ[ео]|дерев[ео]|род[ауе]|ветк[еиу]|по)\s+(?:только\s+)?([а-яё-]{4,})/iu.exec(
      message,
    )?.[1] ||
    /только\s+([а-яё-]{4,}).{0,40}(?:древ|дерев)/iu.exec(message)?.[1] ||
    ""
  );
}

export function explicitViewControlRequest(message: string, view = "") {
  const directInterfaceRequest =
      /(?:покаж(?:и|ь)?|отобраз|остав|убер|скрой|сформир|постро|собер|перейди|открой|приблиз|сфокус|выдел|подсвет|проведи|перемест|перенес|центрир|навед|найди).{0,90}(?:древ|дерев|карточ|фото|сним|ветк)|(?:на древе|в дереве|на карте).{0,90}(?:покаж(?:и|ь)?|отобраз|остав|сформир|постро|найди|выдел|подсвет|перемест|центрир)/iu.test(
        message,
      ),
    treeMovementRequest =
      view === "tree" &&
      /(?:перемест|перенес|проведи|перейди|навед|центрир).{0,40}(?:меня|к|на|до)/iu.test(
        message,
      );
  return directInterfaceRequest || treeMovementRequest;
}

export function shortTreeZoomRequest(message: string, view: string) {
  if (view !== "tree") return null;
  const command = message
    .trim()
    .replace(/[.!?]+$/, "")
    .trim();
  if (
    /^(?:(?:так|ну|давай|ты|ещ[её]|пожалуйста)\s+)*(?:приблизь|приблизи|увеличь)(?:\s+(?:ещ[её]|древо|дерево|пожалуйста))*$/iu.test(
      command,
    )
  )
    return "zoom_in" as const;
  if (
    /^(?:(?:так|ну|давай|ты|ещ[её]|пожалуйста)\s+)*(?:отдали|уменьши)(?:\s+(?:ещ[её]|древо|дерево|пожалуйста))*$/iu.test(
      command,
    )
  )
    return "zoom_out" as const;
  return null;
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

export function containsInternalToolText(
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

export function containsInternalSelectionText(content: string) {
  return /(?:Уточнение к предыдущему вопросу: речь о|Выбран человек:|Пользователь уточнил, что в предыдущем вопросе|Идентификатор карточки для инструментов|\bpersonId\s*:)/iu.test(
    content,
  );
}

export function archiveGraph(family: Family): ResearchGraph {
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

export function researchToolStatus(name: string) {
  const labels: Record<string, string> = {
    get_archive_insights: "Собираю статистику и факты архива…",
    find_missing_data: "Ищу пробелы в карточках людей…",
    find_inconsistencies: "Проверяю противоречия в данных…",
    find_possible_duplicates: "Проверяю похожие карточки…",
    get_research_backlog: "Составляю дальнейшие шаги исследования…",
    get_genealogy_graph: "Строю схему родственных связей…",
    get_surname_group: "Проверяю фамилии при рождении и связи родни…",
    get_evidence_coverage: "Сверяю записи с прикреплёнными источниками…",
    find_evidence_gaps: "Ищу записи без прикреплённых источников…",
    search_people: "Ищу людей в архиве…",
    list_people: "Составляю список людей…",
    get_sources: "Изучаю указанные источники…",
    find_research_resources: "Подбираю подходящие сайты для поиска…",
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
  const labels = [
    ...[...people].map(([id, label]) => ({ id, label, kind: "person" })),
    ...[...photos].map(([id, label]) => ({ id, label, kind: "photo" })),
  ].sort((left, right) => right.id.length - left.id.length);
  return answer
    .split(/(\[\[(?:person|choose-person|photo):[^\]]+\]\]|```[\s\S]*?```)/g)
    .map((segment, index) => {
      if (index % 2) return segment;
      let text = segment.replace(
        /\s*\(\s*(?:personId|photoId)\s*:\s*[^)]+\)/giu,
        "",
      );
      text = text.replace(/\b(?:personId|photoId)\s*[:=]\s*[^\s,;]+/giu, "");
      text = text.replace(
        /(?:фотографи[яюи]|снимок)\s+с\s+идентификатором\s+/giu,
        "",
      );
      for (const { id, label, kind } of labels)
        if (id && text.includes(id))
          text = text.replaceAll(
            new RegExp(
              `(?<![\\p{L}\\p{N}_-])${id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_-])`,
              "gu",
            ),
            () => (kind === "photo" ? `[[photo:${id}|${label}]]` : label),
          );
      text = text.replace(/(?:фотография|снимок)\s+(?=\[\[photo:)/giu, "");
      return text;
    })
    .join("");
}

export function markedPeopleLabel(count: number) {
  const lastTwo = count % 100,
    last = count % 10,
    noun =
      lastTwo >= 11 && lastTwo <= 14
        ? "человек"
        : last === 1
          ? "человек"
          : last >= 2 && last <= 4
            ? "человека"
            : "человек";
  return `${count} ${noun}`;
}

export function needsArchiveLookupRetry(request: string, answer: string) {
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

export function estimateTokens(value: unknown) {
  const serialized =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return Math.max(1, Math.ceil(serialized.length / 4));
}

export function usageTokens(usage: ModelUsage | undefined) {
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

export async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new RangeError("Request too large");
    chunks.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function collectPersonReferences(
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

export function commonPrefixLength(left: string, right: string) {
  let index = 0;
  while (
    index < left.length &&
    index < right.length &&
    left[index] === right[index]
  )
    index++;
  return index;
}

export function repairArchiveMarkers(
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

export function collectSourceReferences(
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
