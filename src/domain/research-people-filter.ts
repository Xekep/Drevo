import { dateBound, fullName, hasRecordedDeath, validDate } from "./dates.ts";
import { archiveConnections } from "./connections.ts";
import { collectPersonSources } from "./person-sources.ts";
import { normalizeResearchText, surnameKeys } from "./research-names.ts";
import type { Family, Person } from "./types.ts";

const textSchema = { type: "string", minLength: 1, maxLength: 200 } as const;
const yearSchema = { type: "integer", minimum: 1, maximum: 9999 } as const;
const relations = [
  "ancestors",
  "descendants",
  "parents",
  "children",
  "spouses",
  "siblings",
] as const;
const eventTypes = [
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
] as const;

const leafSchema = {
  type: "object",
  properties: {
    deceased: {
      type: "boolean",
      description:
        "Записан факт смерти; отсутствие даты смерти само по себе не означает, что человек жив.",
    },
    needsReview: { type: "boolean" },
    surname: {
      ...textSchema,
      description:
        "Текущая фамилия или фамилия при рождении; учитываются русские грамматические формы.",
    },
    nameContains: {
      ...textSchema,
      description:
        "Подстрока полного имени, без учёта регистра и ё/е. Для опечаток и разговорного имени сначала search_people.",
    },
    birthPlaceContains: textSchema,
    deathPlaceContains: textSchema,
    occupationContains: textSchema,
    hasBirthDate: {
      type: "boolean",
      description: "Есть корректная дата рождения, включая неполный год/месяц.",
    },
    hasDeathDate: {
      type: "boolean",
      description: "Есть корректная дата смерти, включая неполный год/месяц.",
    },
    hasSources: {
      type: "boolean",
      description:
        "Есть прикреплённые источники карточки, фактов, событий или наград; наличие не доказывает достоверность.",
    },
    hasPhoto: {
      type: "boolean",
      description: "Есть портрет или отметка на доступной фотографии.",
    },
    sex: { type: "string", enum: ["m", "f", "u"] },
    birthYearFrom: yearSchema,
    birthYearTo: yearSchema,
    deathYearFrom: yearSchema,
    deathYearTo: yearSchema,
    eventType: { type: "string", enum: eventTypes },
    eventPlaceContains: textSchema,
    eventYearFrom: {
      ...yearSchema,
      description:
        "Год начала записанного события. Все event-поля должны совпасть в одном событии.",
    },
    eventYearTo: yearSchema,
    relativeOf: {
      ...textSchema,
      description:
        "ID доступного человека, найденный инструментом поиска. Требуется relation.",
    },
    relation: {
      type: "string",
      enum: relations,
      description:
        "Кем выбранные люди приходятся relativeOf по записанным parent/spouse связям. siblings — есть хотя бы один общий известный родитель. Без догадок и усыновления.",
    },
    deathAgeFrom: {
      type: "integer",
      minimum: 0,
      maximum: 150,
      description: "Возраст смерти не меньше указанного, включительно.",
    },
    deathAgeBefore: {
      type: "integer",
      minimum: 1,
      maximum: 151,
      description:
        "Возраст смерти строго меньше указанного. Для умерших до 18 лет: 18. Неизвестные и пограничные неточные даты не совпадают.",
    },
  },
  minProperties: 1,
  additionalProperties: false,
} as const;

// A bounded schema works with providers without recursive JSON Schema support.
// Field descriptions are already on the root; do not repeat them in each group.
const groupLeafSchema = {
  ...leafSchema,
  properties: Object.fromEntries(
    Object.entries(leafSchema.properties).map(([key, schema]) => [
      key,
      Object.fromEntries(
        Object.entries(schema).filter(([name]) => name !== "description"),
      ),
    ]),
  ),
};
export const PEOPLE_FILTER_SCHEMA = {
  ...leafSchema,
  properties: {
    ...leafSchema.properties,
    allOf: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: groupLeafSchema,
      description: "Все простые условия одновременно.",
    },
    anyOf: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: groupLeafSchema,
      description: "Хотя бы одно простое условие.",
    },
    noneOf: {
      type: "array",
      minItems: 1,
      maxItems: 10,
      items: groupLeafSchema,
      description:
        "Ни одно простое условие; люди с неизвестными данными сохраняются, если не совпали.",
    },
  },
} as const;

type Criteria = {
  deceased?: boolean;
  needsReview?: boolean;
  sex?: "m" | "f" | "u";
  birthYearFrom?: number;
  birthYearTo?: number;
  deathAgeFrom?: number;
  deathAgeBefore?: number;
  deathYearFrom?: number;
  deathYearTo?: number;
};

/** Match only facts certain enough to satisfy every condition. */
function matches(person: Person, criteria: Criteria) {
  if (
    criteria.deceased !== undefined &&
    hasRecordedDeath(person) !== criteria.deceased
  )
    return false;
  if (
    criteria.needsReview !== undefined &&
    !!person.needsReview !== criteria.needsReview
  )
    return false;
  if (criteria.sex !== undefined && person.sex !== criteria.sex) return false;
  if (
    criteria.birthYearFrom !== undefined ||
    criteria.birthYearTo !== undefined
  ) {
    if (!validDate(person.birth)) return false;
    const year = Number(person.birth.slice(0, 4));
    if (criteria.birthYearFrom !== undefined && year < criteria.birthYearFrom)
      return false;
    if (criteria.birthYearTo !== undefined && year > criteria.birthYearTo)
      return false;
  }
  if (
    criteria.deathYearFrom !== undefined ||
    criteria.deathYearTo !== undefined
  ) {
    if (!validDate(person.death)) return false;
    const year = Number(person.death!.slice(0, 4));
    if (criteria.deathYearFrom !== undefined && year < criteria.deathYearFrom)
      return false;
    if (criteria.deathYearTo !== undefined && year > criteria.deathYearTo)
      return false;
  }
  if (
    criteria.deathAgeFrom !== undefined ||
    criteria.deathAgeBefore !== undefined
  ) {
    if (
      !validDate(person.birth) ||
      !validDate(person.death) ||
      dateBound(person.death, true) < dateBound(person.birth, false)
    )
      return false;
    const years = (birth: string, death: string) =>
      Number(death.slice(0, 4)) -
      Number(birth.slice(0, 4)) -
      Number(death.slice(5) < birth.slice(5));
    const minimum = Math.max(
      0,
      years(dateBound(person.birth, true), dateBound(person.death, false)),
    );
    const maximum = years(
      dateBound(person.birth, false),
      dateBound(person.death, true),
    );
    if (criteria.deathAgeFrom !== undefined && minimum < criteria.deathAgeFrom)
      return false;
    if (
      criteria.deathAgeBefore !== undefined &&
      maximum >= criteria.deathAgeBefore
    )
      return false;
  }
  return true;
}

function compileCriteria(family: Family, value: unknown) {
  const available = new Set(family.people.map((person) => person.id));
  const sources = new Map<string, boolean>();
  const photographed = new Set(
    family.photos?.flatMap((photo) => photo.tags.map((tag) => tag.personId)) ||
      [],
  );
  const relativeSets = new Map<string, Set<string>>();
  let graph:
    | {
        parents: Map<string, string[]>;
        children: Map<string, string[]>;
        spouses: Map<string, string[]>;
      }
    | undefined;
  function relatives(id: string, relation: string) {
    if (!available.has(id))
      throw new Error("Человек не найден в доступном архиве");
    const key = `${id}\0${relation}`;
    const cached = relativeSets.get(key);
    if (cached) return cached;
    if (!graph) {
      graph = { parents: new Map(), children: new Map(), spouses: new Map() };
      const add = (map: Map<string, string[]>, from: string, to: string) => {
        const neighbours = map.get(from) || [];
        neighbours.push(to);
        map.set(from, neighbours);
      };
      for (const edge of archiveConnections(family)) {
        if (!available.has(edge.from) || !available.has(edge.to)) continue;
        if (edge.type === "parent") {
          add(graph.parents, edge.to, edge.from);
          add(graph.children, edge.from, edge.to);
        } else if (edge.type === "spouse") {
          add(graph.spouses, edge.from, edge.to);
          add(graph.spouses, edge.to, edge.from);
        }
      }
    }
    const found = new Set<string>();
    if (relation === "siblings") {
      for (const parent of graph.parents.get(id) || [])
        for (const child of graph.children.get(parent) || [])
          if (child !== id) found.add(child);
    } else {
      const pending = [id];
      const visited = new Set([id]);
      const neighbours = ["ancestors", "parents"].includes(relation)
        ? graph.parents
        : ["descendants", "children"].includes(relation)
          ? graph.children
          : graph.spouses;
      for (let index = 0; index < pending.length; index++) {
        for (const next of neighbours.get(pending[index]) || []) {
          if (visited.has(next)) continue;
          visited.add(next);
          found.add(next);
          if (relation === "ancestors" || relation === "descendants")
            pending.push(next);
        }
      }
    }
    relativeSets.set(key, found);
    return found;
  }
  const contains = (field: string | undefined, query: string) =>
    normalizeResearchText(field || "").includes(query);
  function compile(
    value: unknown,
    grouped = false,
  ): (person: Person) => boolean {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Укажите условия отбора людей");
    const entries = Object.entries(value);
    if (!entries.length) throw new Error("Укажите хотя бы одно условие отбора");
    const tests: Array<(person: Person) => boolean> = [];
    for (const [key, item] of entries) {
      if (["allOf", "anyOf", "noneOf"].includes(key)) {
        if (grouped || !Array.isArray(item) || !item.length || item.length > 10)
          throw new Error(
            "Группа должна содержать от 1 до 10 простых условий без вложенных групп",
          );
        const children = item.map((child) => compile(child, true));
        tests.push((person) =>
          key === "allOf"
            ? children.every((test) => test(person))
            : key === "anyOf"
              ? children.some((test) => test(person))
              : !children.some((test) => test(person)),
        );
        continue;
      }
      if (!Object.hasOwn(leafSchema.properties, key))
        throw new Error(`Неизвестное условие отбора: ${key}`);
      const schema = leafSchema.properties[
        key as keyof typeof leafSchema.properties
      ] as {
        type: string;
        enum?: readonly string[];
        minimum?: number;
        maximum?: number;
      };
      if (schema.type === "boolean" && typeof item !== "boolean")
        throw new Error(`Условие ${key} должно быть логическим значением`);
      if (
        schema.type === "integer" &&
        (typeof item !== "number" ||
          !Number.isInteger(item) ||
          item < schema.minimum! ||
          item > schema.maximum!)
      )
        throw new Error(`Проверьте числовые границы ${key}`);
      if (
        schema.type === "string" &&
        (typeof item !== "string" ||
          !item.trim() ||
          item.length > 200 ||
          [...item].some(
            (character) =>
              character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          ) ||
          (schema.enum && !schema.enum.includes(item)))
      )
        throw new Error(`Некорректное условие ${key}`);
      if (key.endsWith("Contains")) {
        const text = normalizeResearchText(item as string);
        if (key === "nameContains")
          tests.push((person) => contains(fullName(person), text));
        if (key === "birthPlaceContains")
          tests.push((person) => contains(person.birthPlace, text));
        if (key === "deathPlaceContains")
          tests.push((person) => contains(person.deathPlace, text));
        if (key === "occupationContains")
          tests.push((person) => contains(person.occupation, text));
      }
      if (key === "surname") {
        const requested = surnameKeys(item as string);
        tests.push((person) =>
          [person.surname, person.maidenName || ""].some(
            (name) =>
              name &&
              [...surnameKeys(name)].some((form) => requested.has(form)),
          ),
        );
      }
      if (key === "hasBirthDate")
        tests.push((person) => Boolean(validDate(person.birth)) === item);
      if (key === "hasDeathDate")
        tests.push((person) => Boolean(validDate(person.death)) === item);
      if (key === "hasSources")
        tests.push((person) => {
          if (!sources.has(person.id))
            sources.set(person.id, collectPersonSources(person).length > 0);
          return sources.get(person.id) === item;
        });
      if (key === "hasPhoto")
        tests.push(
          (person) =>
            Boolean(person.photo || photographed.has(person.id)) === item,
        );
    }
    const criteria = value as Criteria;
    const fields = value as Record<string, unknown>;
    for (const prefix of ["birth", "death", "event"]) {
      const from = fields[`${prefix}YearFrom`],
        to = fields[`${prefix}YearTo`];
      if (typeof from === "number" && typeof to === "number" && from > to)
        throw new Error("Начальный год не может быть больше конечного");
    }
    if (
      criteria.deathAgeFrom !== undefined &&
      criteria.deathAgeBefore !== undefined &&
      criteria.deathAgeFrom >= criteria.deathAgeBefore
    )
      throw new Error("Возрастной диапазон пуст");
    if ((fields.relativeOf === undefined) !== (fields.relation === undefined))
      throw new Error("Укажите вместе relativeOf и relation");
    if (fields.relativeOf !== undefined) {
      const ids = relatives(
        fields.relativeOf as string,
        fields.relation as string,
      );
      tests.push((person) => ids.has(person.id));
    }
    if (entries.some(([key]) => key.startsWith("event"))) {
      const place =
        typeof fields.eventPlaceContains === "string"
          ? normalizeResearchText(fields.eventPlaceContains)
          : undefined;
      tests.push((person) =>
        (person.events || []).some((event) => {
          if (fields.eventType !== undefined && event.type !== fields.eventType)
            return false;
          if (place !== undefined && !contains(event.place, place))
            return false;
          if (
            fields.eventYearFrom !== undefined ||
            fields.eventYearTo !== undefined
          ) {
            if (!validDate(event.date)) return false;
            const year = Number(event.date!.slice(0, 4));
            if (
              fields.eventYearFrom !== undefined &&
              year < (fields.eventYearFrom as number)
            )
              return false;
            if (
              fields.eventYearTo !== undefined &&
              year > (fields.eventYearTo as number)
            )
              return false;
          }
          return true;
        }),
      );
    }
    return (person) =>
      matches(person, criteria) && tests.every((test) => test(person));
  }
  return compile(value);
}

function selectResearchPeople(family: Family, value: unknown, mode: unknown) {
  if (mode !== "include" && mode !== "exclude")
    throw new Error("Выберите включение или исключение по условию");
  const match = compileCriteria(family, value);
  const matched = new Set(
    family.people.filter(match).map((person) => person.id),
  );
  return {
    people: family.people.filter((person) =>
      mode === "include" ? matched.has(person.id) : !matched.has(person.id),
    ),
    matchedCount: matched.size,
    totalPeople: family.people.length,
  };
}

export function filterResearchPeople(
  family: Family,
  value: unknown,
  mode: unknown,
) {
  const selected = selectResearchPeople(family, value, mode);
  return {
    personIds: selected.people.map((person) => person.id),
    matchedCount: selected.matchedCount,
    totalPeople: selected.totalPeople,
  };
}

export function queryResearchPeople(family: Family, raw: unknown) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Укажите параметры поиска");
  const args = raw as Record<string, unknown>;
  if (
    Object.keys(args).some(
      (key) => !["criteria", "mode", "offset", "limit"].includes(key),
    )
  )
    throw new Error("Неизвестный параметр поиска");
  const pageNumber = (key: string, fallback: number, maximum: number) => {
    const value = args[key] === undefined ? fallback : args[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0 ||
      value > maximum
    )
      throw new Error(`Некорректный параметр ${key}`);
    return value;
  };
  const offset = pageNumber("offset", 0, 1_000_000),
    limit = pageNumber("limit", 50, 100);
  const mode = args.mode === undefined ? "include" : args.mode;
  const selected = selectResearchPeople(family, args.criteria, mode);
  const total = selected.people.length;
  const hasMore = limit > 0 && offset + limit < total;
  return {
    mode,
    total,
    matchedCount: selected.matchedCount,
    totalPeople: selected.totalPeople,
    offset,
    limit,
    countOnly: limit === 0,
    hasMore,
    nextOffset: hasMore ? offset + limit : null,
    people:
      limit === 0
        ? []
        : selected.people
            .sort(
              (a, b) =>
                fullName(a).localeCompare(fullName(b), "ru") ||
                a.id.localeCompare(b.id),
            )
            .slice(offset, offset + limit)
            .map((person) => ({
              id: person.id,
              name: fullName(person),
              sex: person.sex,
              birth: person.birth || null,
              death: person.death || null,
              deceased: hasRecordedDeath(person),
              birthPlace: person.birthPlace || null,
              deathPlace: person.deathPlace || null,
            })),
  };
}
