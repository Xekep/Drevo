import type { Family, PlaceLocation } from "./types.ts";
import { fullName } from "./dates.ts";
import { normalizeResearchText } from "./research-names.ts";
import {
  compileResearchEventCriteria,
  EVENT_CRITERIA_SCHEMA,
  eventEvidence,
  researchEventRecords,
  researchQueryPage,
  researchSourcePredicate,
  boundedResearchItems,
  type ResearchEventRecord,
} from "./research-event-query.ts";

export const PLACE_QUERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    criteria: {
      type: "object",
      additionalProperties: false,
      properties: {
        nameContains: { type: "string", minLength: 1, maxLength: 200 },
        nameEquals: { type: "string", minLength: 1, maxLength: 200 },
        hasCoordinates: { type: "boolean" },
        event: {
          ...EVENT_CRITERIA_SCHEMA,
          description:
            "Место, где есть хотя бы одно событие с этими условиями; все условия относятся к одному событию и одному его источнику.",
        },
      },
    },
    offset: { type: "integer", minimum: 0, maximum: 1000000 },
    limit: { type: "integer", minimum: 0, maximum: 100 },
  },
} as const;

export function queryResearchPlaces(
  family: Family,
  raw: unknown,
  sources = true,
) {
  const { value, offset, limit } = researchQueryPage(raw, [
    "criteria",
    "offset",
    "limit",
  ]);
  const criteria = value.criteria ?? {};
  if (!criteria || typeof criteria !== "object" || Array.isArray(criteria))
    throw new Error("Укажите условия отбора мест");
  const c = criteria as Record<string, unknown>;
  for (const [key, item] of Object.entries(c)) {
    if (!Object.hasOwn(PLACE_QUERY_SCHEMA.properties.criteria.properties, key))
      throw new Error(`Неизвестное условие места: ${key}`);
    if (key === "hasCoordinates") {
      if (typeof item !== "boolean")
        throw new Error("hasCoordinates должно быть логическим значением");
    } else if (
      key !== "event" &&
      (typeof item !== "string" ||
        !item.trim() ||
        item.length > 200 ||
        /[\p{Cc}]/u.test(item))
    )
      throw new Error(`Некорректное условие ${key}`);
  }
  const match =
    c.event === undefined
      ? null
      : compileResearchEventCriteria(c.event, family, sources);
  const people = new Map(family.people.map((p) => [p.id, p]));
  const groups = new Map<
    string,
    {
      name: string;
      events: ResearchEventRecord[];
      photos: string[];
      people: Set<string>;
      locations: Map<string, PlaceLocation>;
    }
  >();
  const add = (
    name: string | undefined,
    ids: string[],
    event?: ResearchEventRecord,
    photo?: string,
    location?: PlaceLocation,
  ) => {
    if (!name?.trim()) return;
    const key = normalizeResearchText(name);
    if (
      c.nameContains !== undefined &&
      !key.includes(normalizeResearchText(String(c.nameContains)))
    )
      return;
    if (
      c.nameEquals !== undefined &&
      key !== normalizeResearchText(String(c.nameEquals))
    )
      return;
    const group = groups.get(key) || {
      name: name.trim(),
      events: [],
      photos: [],
      people: new Set<string>(),
      locations: new Map<string, PlaceLocation>(),
    };
    if (event) group.events.push(event);
    if (photo) group.photos.push(photo);
    for (const id of ids) if (people.has(id)) group.people.add(id);
    if (
      location &&
      normalizeResearchText(location.place) === key &&
      Number.isFinite(location.lat) &&
      Number.isFinite(location.lon) &&
      Math.abs(location.lat) <= 90 &&
      Math.abs(location.lon) <= 180
    )
      group.locations.set(`${location.lat}:${location.lon}`, location);
    groups.set(key, group);
  };
  for (const event of researchEventRecords(family))
    if (!match || match(event))
      add(event.place, event.people, event, undefined, event.location);
  if (!match && sources)
    for (const photo of family.photos || [])
      add(
        photo.place,
        photo.tags.map((tag) => tag.personId),
        undefined,
        photo.id,
      );
  const selected = [...groups.values()]
    .filter(
      (group) =>
        c.hasCoordinates === undefined ||
        !!group.locations.size === c.hasCoordinates,
    )
    .sort((a, b) => a.name.localeCompare(b.name, "ru"));
  const { records: places, ...page } = boundedResearchItems(
    selected,
    offset,
    limit,
    (group) => ({
      name: group.name,
      eventCount: group.events.length,
      photoCount: group.photos.length,
      peopleCount: group.people.size,
      people: [...group.people]
        .slice(0, 5)
        .map((id) => ({ id, name: fullName(people.get(id)!) })),
      locations: [...group.locations.values()].slice(0, 3),
      locationCount: group.locations.size,
      evidence: group.events
        .slice(0, 1)
        .map((event) =>
          eventEvidence(
            event,
            people,
            sources,
            researchSourcePredicate(c.event),
          ),
        ),
      notice:
        "Группировка по записанному названию: одноимённые места могут иметь разные координаты. Исторические названия автоматически не объединяются; переезды не предполагаются. Примеры людей и оснований ограничены; количества относятся ко всем совпадениям.",
    }),
  );
  return {
    total: selected.length,
    offset,
    countOnly: limit === 0,
    ...page,
    places,
  };
}
