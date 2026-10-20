import type { Family, Person, Source, PlaceLocation } from "./types.ts";
import { fullName, validDate, hasRecordedDeath } from "./dates.ts";
import { normalizeResearchText } from "./research-names.ts";
import {
  researchEvidenceAnchor,
  researchEvidencePath,
} from "./research-evidence.ts";

export const RESEARCH_EVENT_TYPES = [
  "birth",
  "death",
  "residence",
  "move",
  "education",
  "work",
  "military",
  "marriage",
  "divorce",
  "baptism",
  "burial",
  "other",
  "civil_union",
  "partnership",
  "union_ending",
  "union_ongoing",
] as const;
export type ResearchEventRecord = {
  id: string;
  type: string;
  title: string;
  date?: string;
  dateText?: string;
  endDate?: string;
  place?: string;
  location?: PlaceLocation;
  people: string[];
  sources: Source[];
  sourceScopes: string[];
  anchor: string;
};
const EVENT_NAMES: Record<string, string> = {
  birth: "Рождение",
  death: "Смерть",
  marriage: "Брак",
  divorce: "Развод",
  civil_union: "Гражданский союз",
  partnership: "Партнёрство",
  union_ending: "Окончание союза",
  union_ongoing: "Продолжение союза",
  education: "Образование",
  work: "Работа",
  military: "Военная служба",
  residence: "Проживание",
  move: "Переезд",
  baptism: "Крещение",
  burial: "Захоронение",
  other: "Событие",
};

/** Recorded records only. A shared union has one event, not one per spouse. */
export function researchEventRecords(family: Family): ResearchEventRecord[] {
  const records: ResearchEventRecord[] = [];
  const people = new Set(family.people.map((p) => p.id));
  for (const p of family.people) {
    for (const type of ["birth", "death"] as const) {
      if (
        type === "birth"
          ? !(p.birth || p.birthPlace)
          : !(hasRecordedDeath(p) || p.deathPlace)
      )
        continue;
      const dateClaim = type === "birth" ? p.birthDateClaim : p.deathDateClaim;
      const placeClaim =
        type === "birth" ? p.birthPlaceClaim : p.deathPlaceClaim;
      const date = type === "birth" ? p.birth : p.death,
        place = type === "birth" ? p.birthPlace : p.deathPlace;
      const a = dateClaim && dateClaim.value === date ? dateClaim.sources : [],
        b = placeClaim && placeClaim.value === place ? placeClaim.sources : [];
      records.push({
        id: JSON.stringify([type, p.id]),
        type,
        title: EVENT_NAMES[type],
        date: type === "birth" ? p.birth : p.death,
        place: type === "birth" ? p.birthPlace : p.deathPlace,
        location: type === "birth" ? p.birthLocation : p.deathLocation,
        people: [p.id],
        sources: [...a, ...b],
        sourceScopes: [...a.map(() => "date"), ...b.map(() => "place")],
        anchor: researchEvidenceAnchor(type, p.id),
      });
    }
    for (const event of p.events || []) {
      const a = event.sources || [],
        b =
          event.dateClaim && event.dateClaim.value === event.date
            ? event.dateClaim.sources
            : [],
        c =
          event.placeClaim && event.placeClaim.value === event.place
            ? event.placeClaim.sources
            : [];
      records.push({
        ...event,
        id: JSON.stringify(["event", p.id, event.id]),
        title: event.title || EVENT_NAMES[event.type],
        people: [p.id],
        sources: [...a, ...b, ...c],
        sourceScopes: [
          ...a.map(() => "event"),
          ...b.map(() => "date"),
          ...c.map(() => "place"),
        ],
        anchor: researchEvidenceAnchor("event", event.id),
      });
    }
  }
  for (const union of family.unions || []) {
    if (!union.participants.every((id) => people.has(id))) continue;
    for (const stage of [
      "formation",
      "divorce",
      "ending",
      "ongoing",
    ] as const) {
      const milestone = union[stage];
      if (!milestone) continue;
      const type =
        stage === "formation"
          ? union.type
          : stage === "divorce"
            ? "divorce"
            : stage === "ending"
              ? "union_ending"
              : "union_ongoing";
      const a = milestone.sources || [],
        b = union.sources || [];
      records.push({
        ...milestone,
        id: JSON.stringify(["union", union.id, stage]),
        type,
        title: EVENT_NAMES[type],
        people: [...union.participants],
        sources: [...a, ...b],
        sourceScopes: [...a.map(() => "event"), ...b.map(() => "union")],
        anchor: researchEvidenceAnchor("union", union.id),
      });
    }
  }
  return records;
}

const text = { type: "string", minLength: 1, maxLength: 200 } as const;
export const EVENT_CRITERIA_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    type: { type: "string", enum: RESEARCH_EVENT_TYPES },
    personId: text,
    placeContains: text,
    titleContains: text,
    yearFrom: { type: "integer", minimum: 1, maximum: 9999 },
    yearTo: { type: "integer", minimum: 1, maximum: 9999 },
    sourceType: text,
    sourceTitleContains: text,
    sourceReferenceContains: text,
    hasSources: { type: "boolean" },
  },
} as const;
export function compileResearchEventCriteria(
  raw: unknown,
  family: Family,
  sources = true,
) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Укажите условия отбора событий");
  const value = raw as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) {
    if (!Object.hasOwn(EVENT_CRITERIA_SCHEMA.properties, key))
      throw new Error(`Неизвестное условие события: ${key}`);
    if (key.startsWith("source") || key === "hasSources")
      if (!sources)
        throw new Error("Для отбора по источникам нужен доступ к источникам");
    if (key === "hasSources") {
      if (typeof item !== "boolean")
        throw new Error("hasSources должно быть логическим значением");
    } else if (key === "yearFrom" || key === "yearTo") {
      if (!Number.isInteger(item) || Number(item) < 1 || Number(item) > 9999)
        throw new Error("Проверьте границы лет");
    } else if (
      typeof item !== "string" ||
      !item.trim() ||
      item.length > 200 ||
      /[\p{Cc}]/u.test(item)
    )
      throw new Error(`Некорректное условие ${key}`);
  }
  if (
    value.type !== undefined &&
    !RESEARCH_EVENT_TYPES.includes(
      value.type as (typeof RESEARCH_EVENT_TYPES)[number],
    )
  )
    throw new Error("Неизвестный тип события");
  if (
    value.personId !== undefined &&
    !family.people.some((p) => p.id === value.personId)
  )
    throw new Error("Человек недоступен");
  if (
    value.yearFrom !== undefined &&
    value.yearTo !== undefined &&
    Number(value.yearFrom) > Number(value.yearTo)
  )
    throw new Error("Начальный год больше конечного");
  const contains = (field: string | undefined, term: unknown) =>
    term === undefined ||
    normalizeResearchText(field || "").includes(
      normalizeResearchText(String(term)),
    );
  return (event: ResearchEventRecord) => {
    if (value.type !== undefined && event.type !== value.type) return false;
    if (
      value.personId !== undefined &&
      !event.people.includes(String(value.personId))
    )
      return false;
    if (
      !contains(event.place, value.placeContains) ||
      !contains(event.title, value.titleContains)
    )
      return false;
    if (value.yearFrom !== undefined || value.yearTo !== undefined) {
      if (!validDate(event.date)) return false;
      const year = Number(event.date!.slice(0, 4));
      if (
        (value.yearFrom !== undefined && year < Number(value.yearFrom)) ||
        (value.yearTo !== undefined && year > Number(value.yearTo))
      )
        return false;
    }
    if (
      value.hasSources !== undefined &&
      Boolean(event.sources.length) !== value.hasSources
    )
      return false;
    if (
      Object.keys(value).some((key) => key.startsWith("source")) &&
      !event.sources.some(
        (source) =>
          (value.sourceType === undefined ||
            normalizeResearchText(source.type) ===
              normalizeResearchText(String(value.sourceType))) &&
          contains(source.title, value.sourceTitleContains) &&
          contains(source.reference, value.sourceReferenceContains),
      )
    )
      return false;
    return true;
  };
}

export function eventEvidence(
  event: ResearchEventRecord,
  people: ReadonlyMap<string, Person>,
  sources = true,
  sourcePredicate?: (source: Source) => boolean,
) {
  const personId = event.people[0];
  const person = people.get(personId)!;
  return {
    person: { id: personId, name: fullName(person) },
    event: {
      label: `${event.title} · ${fullName(person)}${event.date ? ` · ${event.date}` : ""}`,
      href: researchEvidencePath(personId, event.anchor),
    },
    sourceCount: sources ? event.sources.length : null,
    matchingSourceCount: sources
      ? event.sources.filter(
          (source) => !sourcePredicate || sourcePredicate(source),
        ).length
      : null,
    sources: sources
      ? event.sources
          .map((source, i) => ({ source, scope: event.sourceScopes[i] }))
          .filter(({ source }) => !sourcePredicate || sourcePredicate(source))
          .slice(0, 3)
          .map(({ source, scope }) => ({
            title:
              source.title.length > 200
                ? source.title.slice(0, 200) + "…"
                : source.title,
            type: source.type,
            reference:
              source.reference.length > 600
                ? source.reference.slice(0, 600) + "…"
                : source.reference,
            ...(source.url && source.url.length <= 2048
              ? { url: source.url }
              : {}),
            ...(source.documentId
              ? {
                  documentId: source.documentId,
                  documentPage: source.documentPage || 1,
                }
              : {}),
            truncated:
              source.title.length > 200 ||
              source.reference.length > 600 ||
              !!source.note ||
              !!source.repository ||
              (source.url?.length || 0) > 2048,
            scope,
            href: researchEvidencePath(
              personId,
              researchEvidenceAnchor("source", source),
            ),
          }))
      : [],
    notice:
      "Записанные сведения и прикреплённые источники не являются автоматическим доказательством достоверности. scope указывает, к чему прикреплён источник; union не подтверждает отдельно дату или место. Здесь до трёх кратких источников; полные сведения доступны по href или через get_sources/get_person.",
  };
}

export function researchSourcePredicate(
  raw: unknown,
): ((source: Source) => boolean) | undefined {
  const value =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  if (
    !["sourceType", "sourceTitleContains", "sourceReferenceContains"].some(
      (key) => value[key] !== undefined,
    )
  )
    return;
  const contains = (text: string, query: unknown) =>
    query === undefined ||
    normalizeResearchText(text).includes(normalizeResearchText(String(query)));
  return (source) =>
    (value.sourceType === undefined ||
      normalizeResearchText(source.type) ===
        normalizeResearchText(String(value.sourceType))) &&
    contains(source.title, value.sourceTitleContains) &&
    contains(source.reference, value.sourceReferenceContains);
}

export const EVENT_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    criteria: EVENT_CRITERIA_SCHEMA,
    offset: { type: "integer", minimum: 0, maximum: 1000000 },
    limit: { type: "integer", minimum: 0, maximum: 100 },
  },
} as const;
export function researchQueryPage(raw: unknown, keys: string[]) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Укажите параметры запроса");
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new Error("Неизвестный параметр запроса");
  const offset = value.offset ?? 0,
    limit = value.limit ?? 50;
  if (
    !Number.isInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) > 1000000 ||
    !Number.isInteger(limit) ||
    Number(limit) < 0 ||
    Number(limit) > 100
  )
    throw new Error("Некорректная страница запроса");
  return { value, offset: Number(offset), limit: Number(limit) };
}

/** Keep tool responses bounded without corrupting JSON or claiming that a
 * shortened page is the whole result. Counts refer to the full selection. */
export function boundedResearchItems<T, R>(
  items: T[],
  offset: number,
  limit: number,
  project: (item: T) => R,
) {
  const records: R[] = [];
  let size = 0;
  for (const item of limit ? items.slice(offset, offset + limit) : []) {
    const record = project(item),
      characters = JSON.stringify(record).length;
    if (records.length && size + characters > 24000) break;
    records.push(record);
    size += characters;
  }
  const responseLimited =
    records.length < Math.min(limit, Math.max(0, items.length - offset));
  const hasMore = limit > 0 && offset + records.length < items.length;
  return {
    records,
    limit: responseLimited ? records.length : limit,
    hasMore,
    nextOffset: hasMore ? offset + records.length : null,
    ...(responseLimited
      ? {
          responseLimited: true,
          notice:
            "Страница сокращена по размеру ответа. Продолжайте с nextOffset; total по-прежнему точный.",
        }
      : {}),
  };
}
export function queryResearchEvents(
  family: Family,
  raw: unknown,
  sources = true,
) {
  const { value, offset, limit } = researchQueryPage(raw, [
    "criteria",
    "offset",
    "limit",
  ]);
  const match = compileResearchEventCriteria(
    value.criteria ?? {},
    family,
    sources,
  );
  const records = researchEventRecords(family)
    .filter(match)
    .sort(
      (a, b) =>
        (a.date || "9999").localeCompare(b.date || "9999") ||
        a.id.localeCompare(b.id),
    );
  const people = new Map(family.people.map((p) => [p.id, p]));
  const { records: events, ...page } = boundedResearchItems(
    records,
    offset,
    limit,
    (event) => ({
      id: event.id,
      type: event.type,
      title: event.title,
      date: event.date || null,
      dateText: event.dateText || null,
      endDate: event.endDate || null,
      place: event.place || null,
      people: event.people.map((id) => ({
        id,
        name: fullName(people.get(id)!),
      })),
      evidence: eventEvidence(
        event,
        people,
        sources,
        researchSourcePredicate(value.criteria),
      ),
    }),
  );
  return {
    total: records.length,
    offset,
    countOnly: limit === 0,
    ...page,
    events,
  };
}

export function getResearchEvent(family: Family, raw: unknown, sources = true) {
  if (
    !raw ||
    typeof raw !== "object" ||
    Array.isArray(raw) ||
    Object.keys(raw).length !== 1 ||
    !("eventId" in raw) ||
    typeof raw.eventId !== "string" ||
    raw.eventId.length > 1000
  )
    throw new Error("Укажите eventId из результата query_events");
  const event = researchEventRecords(family).find(
    (item) => item.id === raw.eventId,
  );
  if (!event) throw new Error("Событие не найдено в доступном архиве");
  return {
    id: event.id,
    type: event.type,
    title: event.title,
    date: event.date || null,
    dateText: event.dateText || null,
    endDate: event.endDate || null,
    place: event.place || null,
    evidence: eventEvidence(
      event,
      new Map(family.people.map((p) => [p.id, p])),
      sources,
    ),
  };
}
