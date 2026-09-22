import { fullName } from "./dates.ts";
import { analyzeFamilyInsights } from "./family-insights.ts";
import { analyzeKinship } from "./kinship-analysis.ts";
import type { Family, Person } from "./types.ts";

export type ResearchScope = "tree:read" | "sources:read" | "analysis:read";

export type ResearchToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scope: ResearchScope;
};

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[] = [],
) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});

export const RESEARCH_TOOL_DEFINITIONS: ResearchToolDefinition[] = [
  {
    name: "search_people",
    description:
      "Найти людей в семейном архиве по имени, фамилии, отчеству, году или месту.",
    scope: "tree:read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 100 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
      },
      ["query"],
    ),
  },
  {
    name: "get_person",
    description: "Получить карточку человека без фотографий и служебных полей.",
    scope: "tree:read",
    inputSchema: objectSchema(
      { personId: { type: "string", minLength: 1, maxLength: 200 } },
      ["personId"],
    ),
  },
  {
    name: "get_family",
    description:
      "Получить ближайшую семью человека: родителей, супругов и детей.",
    scope: "tree:read",
    inputSchema: objectSchema(
      { personId: { type: "string", minLength: 1, maxLength: 200 } },
      ["personId"],
    ),
  },
  {
    name: "get_ancestors",
    description: "Получить известных предков человека на заданную глубину.",
    scope: "tree:read",
    inputSchema: objectSchema(
      {
        personId: { type: "string", minLength: 1, maxLength: 200 },
        depth: { type: "integer", minimum: 1, maximum: 8, default: 4 },
      },
      ["personId"],
    ),
  },
  {
    name: "get_descendants",
    description: "Получить известных потомков человека на заданную глубину.",
    scope: "tree:read",
    inputSchema: objectSchema(
      {
        personId: { type: "string", minLength: 1, maxLength: 200 },
        depth: { type: "integer", minimum: 1, maximum: 8, default: 4 },
      },
      ["personId"],
    ),
  },
  {
    name: "get_relationship",
    description:
      "Определить документированную цепочку родства между двумя людьми.",
    scope: "analysis:read",
    inputSchema: objectSchema(
      {
        firstPersonId: { type: "string", minLength: 1, maxLength: 200 },
        secondPersonId: { type: "string", minLength: 1, maxLength: 200 },
      },
      ["firstPersonId", "secondPersonId"],
    ),
  },
  {
    name: "get_sources",
    description:
      "Получить источники карточки, жизненных событий и наград конкретного человека.",
    scope: "sources:read",
    inputSchema: objectSchema(
      { personId: { type: "string", minLength: 1, maxLength: 200 } },
      ["personId"],
    ),
  },
  {
    name: "find_missing_data",
    description:
      "Найти пробелы в генеалогических данных. Можно ограничить анализ одним человеком.",
    scope: "analysis:read",
    inputSchema: objectSchema({
      personId: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
    }),
  },
  {
    name: "find_inconsistencies",
    description:
      "Найти вычисляемые противоречия и подозрительные данные без домысливания фактов.",
    scope: "analysis:read",
    inputSchema: objectSchema({}),
  },
  {
    name: "get_archive_insights",
    description:
      "Получить рассчитанную статистику полноты, поколений, источников и общие факты по архиву.",
    scope: "analysis:read",
    inputSchema: objectSchema({}),
  },
];

function normalized(value: string) {
  return value
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ");
}

function cleanPerson(person: Person) {
  const hidden = new Set([
    "createdBy",
    "photo",
    "generation",
    "column",
    "sources",
  ]);
  const result = Object.fromEntries(
    Object.entries(person).filter(([key]) => !hidden.has(key)),
  ) as Record<string, unknown>;
  if (person.events)
    result.events = person.events.map((event) =>
      Object.fromEntries(
        Object.entries(event).filter(([key]) => key !== "sources"),
      ),
    );
  if (person.awards)
    result.awards = person.awards.map((award) =>
      Object.fromEntries(
        Object.entries(award).filter(([key]) => key !== "source"),
      ),
    );
  return result;
}

function personOrThrow(family: Family, id: string) {
  const person = family.people.find((item) => item.id === id);
  if (!person) throw new Error("Человек не найден или недоступен");
  return person;
}

function numberArg(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
) {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`Некорректный параметр ${key}`);
  return Math.min(max, Math.max(min, value));
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  required = true,
) {
  const value = args[key];
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || !value.trim())
    throw new Error(`Некорректный параметр ${key}`);
  return value.trim();
}

function lineage(
  family: Family,
  startId: string,
  depth: number,
  direction: "ancestors" | "descendants",
) {
  personOrThrow(family, startId);
  const people = new Map(family.people.map((person) => [person.id, person]));
  const children = new Map<string, string[]>();
  if (direction === "descendants")
    for (const child of family.people)
      for (const parentId of child.parents) {
        const list = children.get(parentId) || [];
        list.push(child.id);
        children.set(parentId, list);
      }
  const seen = new Set([startId]);
  const queue: Array<{ id: string; level: number }> = [
    { id: startId, level: 0 },
  ];
  const result: Array<{ depth: number; person: ReturnType<typeof cleanPerson> }> =
    [];
  while (queue.length) {
    const current = queue.shift()!;
    if (current.level >= depth) continue;
    const person = people.get(current.id);
    if (!person) continue;
    const ids =
      direction === "ancestors"
        ? person.parents
        : children.get(current.id) || [];
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const relative = people.get(id);
      if (!relative) continue;
      result.push({ depth: current.level + 1, person: cleanPerson(relative) });
      queue.push({ id, level: current.level + 1 });
    }
  }
  return result;
}

function missingFor(person: Person) {
  const missing: string[] = [];
  if (!person.birth) missing.push("дата рождения");
  if (!person.birthPlace.trim()) missing.push("место рождения");
  if (!person.patronymic.trim()) missing.push("отчество");
  if (!person.sources.length && !(person.events || []).some((e) => e.sources?.length))
    missing.push("источники");
  if (!person.parents.length) missing.push("родители");
  else if (!person.parentageComplete) missing.push("полнота сведений о родителях");
  if (person.deceased && !person.death) missing.push("дата смерти");
  return missing;
}

export function executeResearchTool(
  family: Family,
  name: string,
  rawArgs: unknown,
) {
  const args =
    rawArgs && typeof rawArgs === "object"
      ? (rawArgs as Record<string, unknown>)
      : {};

  if (name === "search_people") {
    const query = normalized(stringArg(args, "query")),
      limit = numberArg(args, "limit", 20, 1, 50);
    const matches = family.people
      .map((person) => {
        const fields = [
          fullName(person),
          person.maidenName || "",
          person.birth || "",
          person.death || "",
          person.birthPlace,
          person.deathPlace || "",
        ].map(normalized);
        const score = fields.reduce(
          (value, field, index) =>
            field === query
              ? Math.max(value, 100 - index)
              : field.startsWith(query)
                ? Math.max(value, 80 - index)
                : field.includes(query)
                  ? Math.max(value, 50 - index)
                  : value,
          0,
        );
        return { person, score };
      })
      .filter((item) => item.score > 0)
      .sort(
        (a, b) =>
          b.score - a.score ||
          fullName(a.person).localeCompare(fullName(b.person), "ru"),
      )
      .slice(0, limit)
      .map(({ person }) => ({
        id: person.id,
        name: fullName(person),
        birth: person.birth,
        death: person.death,
        birthPlace: person.birthPlace,
      }));
    return { people: matches, total: matches.length };
  }

  if (name === "get_person") {
    const person = personOrThrow(family, stringArg(args, "personId"));
    return { person: cleanPerson(person) };
  }

  if (name === "get_family") {
    const person = personOrThrow(family, stringArg(args, "personId")),
      people = new Map(family.people.map((item) => [item.id, item])),
      children = family.people.filter((item) => item.parents.includes(person.id));
    return {
      person: cleanPerson(person),
      parents: person.parents.flatMap((id) =>
        people.has(id) ? [cleanPerson(people.get(id)!)] : [],
      ),
      spouses: person.spouses.flatMap((id) =>
        people.has(id) ? [cleanPerson(people.get(id)!)] : [],
      ),
      children: children.map(cleanPerson),
    };
  }

  if (name === "get_ancestors" || name === "get_descendants") {
    const personId = stringArg(args, "personId"),
      depth = numberArg(args, "depth", 4, 1, 8);
    return {
      personId,
      depth,
      people: lineage(
        family,
        personId,
        depth,
        name === "get_ancestors" ? "ancestors" : "descendants",
      ),
    };
  }

  if (name === "get_relationship") {
    const first = personOrThrow(family, stringArg(args, "firstPersonId")),
      second = personOrThrow(family, stringArg(args, "secondPersonId")),
      relation = analyzeKinship(first, second, family.people, family.links);
    const people = new Map(family.people.map((person) => [person.id, person]));
    return {
      first: { id: first.id, name: fullName(first) },
      second: { id: second.id, name: fullName(second) },
      relation,
      path: relation.path.flatMap((id) =>
        people.has(id) ? [{ id, name: fullName(people.get(id)!) }] : [],
      ),
    };
  }

  if (name === "get_sources") {
    const person = personOrThrow(family, stringArg(args, "personId"));
    return {
      person: { id: person.id, name: fullName(person) },
      card: person.sources,
      events: (person.events || [])
        .filter((event) => event.sources?.length)
        .map((event) => ({
          id: event.id,
          type: event.type,
          title: event.title,
          date: event.date,
          sources: event.sources,
        })),
      awards: (person.awards || [])
        .filter((award) => award.source)
        .map((award) => ({
          id: award.id,
          name: award.name,
          year: award.year,
          source: award.source,
        })),
    };
  }

  if (name === "find_missing_data") {
    const requested = stringArg(args, "personId", false),
      limit = numberArg(args, "limit", 30, 1, 100),
      candidates = requested
        ? [personOrThrow(family, requested)]
        : family.people;
    const people = candidates
      .map((person) => ({ person, missing: missingFor(person) }))
      .filter((item) => item.missing.length)
      .sort(
        (a, b) =>
          b.missing.length - a.missing.length ||
          fullName(a.person).localeCompare(fullName(b.person), "ru"),
      )
      .slice(0, limit)
      .map(({ person, missing }) => ({
        id: person.id,
        name: fullName(person),
        missing,
      }));
    return { people, total: people.length };
  }

  if (name === "find_inconsistencies") {
    const warnings = analyzeFamilyInsights(family).warnings,
      people = new Map(family.people.map((person) => [person.id, person]));
    return {
      warnings: warnings.map((warning) => ({
        ...warning,
        people: warning.personIds.flatMap((id) =>
          people.has(id) ? [{ id, name: fullName(people.get(id)!) }] : [],
        ),
      })),
      total: warnings.length,
    };
  }

  if (name === "get_archive_insights") {
    const insights = analyzeFamilyInsights(family);
    return {
      totals: insights.totals,
      completeness: insights.completeness,
      generations: insights.generations,
      facts: insights.facts,
      topSurnames: insights.topSurnames,
      topNames: insights.topNames,
    };
  }

  throw new Error("Неизвестный исследовательский инструмент");
}
