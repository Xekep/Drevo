import { fullName } from "./dates.ts";
import { analyzeFamilyInsights } from "./family-insights.ts";
import { analyzeKinship } from "./kinship-analysis.ts";
import { findPossibleDuplicates } from "./duplicate-analysis.ts";
import { archiveConnections } from "./connections.ts";
import type { Family, Person } from "./types.ts";

const graphRelationLabels: Record<string, string> = {
  adoptive_parent: "приёмный родитель",
  step_parent: "отчим / мачеха",
  godparent: "крёстный родитель",
  nurse: "кормилица",
  sworn_sibling: "названное родство",
  guardian: "опекун",
};

function graphMermaid(
  nodes: Array<{ id: string; name: string }>,
  edges: Array<{ from: string; to: string; type: string }>,
) {
  const aliases = new Map(nodes.map((node, index) => [node.id, `n${index}`]));
  return [
    "graph TD",
    ...nodes.map(
      (node, index) =>
        `  n${index}["${node.name.replaceAll('"', "'").replaceAll("\n", " ")}"]`,
    ),
    ...edges.flatMap((edge) => {
      const from = aliases.get(edge.from),
        to = aliases.get(edge.to);
      if (!from || !to) return [];
      if (edge.type === "parent") return [`  ${from} --> ${to}`];
      if (edge.type === "spouse") return [`  ${from} --- ${to}`];
      const label = graphRelationLabels[edge.type] || edge.type;
      return [`  ${from} -. "${label}" .-> ${to}`];
    }),
  ].join("\n");
}

/** Match grammatical variants against forms actually present in this archive. */
function surnameKeys(value: string) {
  const word = normalized(value);
  const keys = new Set([word]);
  if (word.length < 5) return keys;
  if (/(?:овых|евых|иных|ыных|овым|евым|иным|ыным)$/.test(word))
    keys.add(word.slice(0, -2));
  if (/(?:ова|ева|ина|ына)$/.test(word)) keys.add(word.slice(0, -1));
  if (/(?:ская|цкая)$/.test(word)) keys.add(`${word.slice(0, -2)}ий`);
  if (/(?:ая|яя)$/.test(word))
    for (const suffix of ["ый", "ий", "ой"])
      keys.add(`${word.slice(0, -2)}${suffix}`);
  if (/(?:ов|ев|ин|ын)$/.test(word)) keys.add(`${word}а`);
  if (/(?:ский|цкий)$/.test(word)) keys.add(`${word.slice(0, -2)}ая`);
  if (/(?:ый|ий|ой)$/.test(word)) keys.add(`${word.slice(0, -2)}ая`);
  return keys;
}

export function surnameGroup(family: Family, surname: string) {
  const requested = surnameKeys(surname);
  const matches = family.people.filter((person) =>
    [person.surname, person.maidenName || ""].some(
      (form) =>
        form && [...surnameKeys(form)].some((key) => requested.has(key)),
    ),
  );
  const ids = new Set(matches.map((person) => person.id));
  const available = new Set(family.people.map((person) => person.id));
  for (const person of matches)
    for (const parent of person.parents)
      if (available.has(parent)) ids.add(parent);
  const nodes = family.people
    .filter((person) => ids.has(person.id))
    .map((person) => ({ id: person.id, name: fullName(person) }));
  const edges: Array<{ from: string; to: string; type: string }> = [];
  const spouses = new Set<string>();
  for (const person of family.people.filter((item) => ids.has(item.id))) {
    for (const parent of person.parents)
      if (ids.has(parent))
        edges.push({ from: parent, to: person.id, type: "parent" });
    for (const spouse of person.spouses)
      if (ids.has(spouse)) {
        const pair = [person.id, spouse].sort();
        const key = pair.join("\0");
        if (!spouses.has(key)) {
          spouses.add(key);
          edges.push({ from: pair[0], to: pair[1], type: "spouse" });
        }
      }
  }
  return {
    surname,
    people: matches.map((person) => ({
      id: person.id,
      name: fullName(person),
      surname: person.surname,
      birthSurname: person.maidenName || null,
      birth: person.birth || null,
      birthPlace: person.birthPlace || null,
      death: person.death || null,
    })),
    nodes,
    edges,
    personIds: [...ids],
    mermaid: nodes.length ? graphMermaid(nodes, edges) : "",
  };
}

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
    name: "list_people",
    description:
      "Получить список людей, доступных пользователю в архиве. Используй для просьб перечислить всех людей или продолжений вроде «перечисли их»; для поиска конкретного человека используй search_people.",
    scope: "tree:read",
    inputSchema: objectSchema({
      offset: { type: "integer", minimum: 0, default: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
    }),
  },
  {
    name: "search_people",
    description:
      "Найти людей в семейном архиве по имени, фамилии, отчеству, году или месту. Поиск нормализует порядок слов, падежные окончания и небольшие опечатки.",
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
    name: "get_surname_group",
    description:
      "Получить всех людей с указанной текущей фамилией или фамилией при рождении, включая грамматические формы, и проверенную схему связей с их ближайшими известными родителями. Используй для сводной таблицы по роду и показа ветви на древе. personIds — точный набор для фильтра дерева.",
    scope: "analysis:read",
    inputSchema: objectSchema(
      { surname: { type: "string", minLength: 2, maxLength: 100 } },
      ["surname"],
    ),
  },
  {
    name: "get_evidence_coverage",
    description:
      "Оценить покрытие источниками карточек, событий и наград человека или фамильной группы. Источник карточки связан с карточкой целиком и не доказывает отдельно каждую дату или родство.",
    scope: "sources:read",
    inputSchema: objectSchema({
      personId: { type: "string", minLength: 1, maxLength: 200 },
      surname: { type: "string", minLength: 2, maxLength: 100 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
    }),
  },
  {
    name: "find_evidence_gaps",
    description:
      "Найти записанные события и награды без прикреплённых источников, а также карточки без источников. Это задачи для проверки, а не доказательство неверности записей.",
    scope: "sources:read",
    inputSchema: objectSchema({
      personId: { type: "string", minLength: 1, maxLength: 200 },
      surname: { type: "string", minLength: 2, maxLength: 100 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
    }),
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
      "Получить ближайшую семью человека: родителей, супругов, детей, родных и неполнородных братьев и сестёр.",
    scope: "tree:read",
    inputSchema: objectSchema(
      { personId: { type: "string", minLength: 1, maxLength: 200 } },
      ["personId"],
    ),
  },
  {
    name: "get_cousins",
    description:
      "Найти всех доступных родственников человека одной боковой степени: degree=2 — двоюродные братья и сёстры, degree=3 — троюродные, далее аналогично. Используй также для коротких продолжений диалога вроде «а двоюродные?».",
    scope: "analysis:read",
    inputSchema: objectSchema(
      {
        personId: { type: "string", minLength: 1, maxLength: 200 },
        degree: { type: "integer", minimum: 2, maximum: 10, default: 2 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
      },
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
    name: "search_photos",
    description:
      "Найти доступные пользователю фотографии архива по названию, месту, году, событию, описанию или отмеченному человеку. Поле documentedRelationships содержит только подтверждённые в древе связи между отмеченными людьми; не выводи другие связи по догадке.",
    scope: "sources:read",
    inputSchema: objectSchema({
      query: { type: "string", maxLength: 200 },
      personId: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
    }),
  },
  {
    name: "get_photo",
    description:
      "Получить метаданные доступной фотографии, список отмеченных людей и подтверждённые связи между ними в documentedRelationships. Пустой список означает, что тип связи неизвестен. Для анализа самого изображения после этого используй analyze_photo.",
    scope: "sources:read",
    inputSchema: objectSchema(
      { photoId: { type: "string", minLength: 1, maxLength: 200 } },
      ["photoId"],
    ),
  },
  {
    name: "search_archive",
    description:
      "Искать текст сразу по карточкам людей, биографиям, занятиям, событиям, наградам, источникам и фотографиям. Возвращает тип записи и краткие структурированные совпадения.",
    scope: "analysis:read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 25 },
      },
      ["query"],
    ),
  },
  {
    name: "get_timeline",
    description:
      "Построить хронологию рождений, смертей, жизненных событий и фотографий для одного человека или всего доступного архива.",
    scope: "analysis:read",
    inputSchema: objectSchema({
      personId: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 100 },
    }),
  },
  {
    name: "get_genealogy_graph",
    description:
      "Получить компактный подграф вокруг человека с узлами и рёбрами родителей, супругов и дополнительных связей. Используй как проверенные данные для схем Mermaid.",
    scope: "analysis:read",
    inputSchema: objectSchema(
      {
        personId: { type: "string", minLength: 1, maxLength: 200 },
        direction: {
          type: "string",
          enum: ["ancestors", "descendants", "both"],
          default: "both",
        },
        depth: { type: "integer", minimum: 1, maximum: 6, default: 3 },
        includeSpouses: { type: "boolean", default: true },
        includeExtraRelations: { type: "boolean", default: true },
      },
      ["personId"],
    ),
  },
  {
    name: "get_place_summary",
    description:
      "Собрать все доступные упоминания места в рождениях, смертях, жизненных событиях и фотографиях.",
    scope: "analysis:read",
    inputSchema: objectSchema(
      {
        query: { type: "string", minLength: 1, maxLength: 200 },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      ["query"],
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
    name: "find_possible_duplicates",
    description:
      "Найти вероятные дубли карточек по вариантам написания имени и фамилии, неполным датам, местам и совпадающим родственникам. Результат является гипотезой для ручной проверки.",
    scope: "analysis:read",
    inputSchema: objectSchema({
      personId: { type: "string", minLength: 1, maxLength: 200 },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 30 },
    }),
  },
  {
    name: "get_branch_insights",
    description:
      "Проанализировать выбранную родословную ветку: размер, полноту, пробелы и вычисляемые предупреждения на заданной глубине.",
    scope: "analysis:read",
    inputSchema: objectSchema(
      {
        personId: { type: "string", minLength: 1, maxLength: 200 },
        direction: {
          type: "string",
          enum: ["ancestors", "descendants", "both"],
          default: "ancestors",
        },
        depth: { type: "integer", minimum: 1, maximum: 8, default: 4 },
      },
      ["personId"],
    ),
  },
  {
    name: "get_research_backlog",
    description:
      "Составить детерминированный список следующих документов для поиска, ранжированный по ожидаемой ценности закрытия пробелов. Можно ограничить выбранной веткой.",
    scope: "analysis:read",
    inputSchema: objectSchema({
      personId: { type: "string", minLength: 1, maxLength: 200 },
      direction: {
        type: "string",
        enum: ["ancestors", "descendants", "both"],
        default: "ancestors",
      },
      depth: { type: "integer", minimum: 1, maximum: 8, default: 4 },
      limit: { type: "integer", minimum: 1, maximum: 50, default: 12 },
    }),
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
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/\s+/g, " ");
}

function searchTokens(value: string) {
  return normalized(value).match(/[\p{L}\p{N}]+/gu) || [];
}

function tokenSimilarity(left: string, right: string) {
  if (left === right) return 1;
  if (!left || !right) return 0;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index),
    beforePrevious = [...previous];
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
      const substitution =
        previous[rightIndex - 1] +
        Number(left[leftIndex - 1] !== right[rightIndex - 1]);
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        substitution,
      );
      if (
        leftIndex > 1 &&
        rightIndex > 1 &&
        left[leftIndex - 1] === right[rightIndex - 2] &&
        left[leftIndex - 2] === right[rightIndex - 1]
      )
        current[rightIndex] = Math.min(
          current[rightIndex],
          beforePrevious[rightIndex - 2] + 1,
        );
    }
    beforePrevious = previous;
    previous = current;
  }
  const editScore =
    1 - previous[right.length] / Math.max(left.length, right.length);
  let prefix = 0;
  while (
    prefix < left.length &&
    prefix < right.length &&
    left[prefix] === right[prefix]
  )
    prefix++;
  const prefixScore = prefix >= 2 ? Math.min(0.82, 0.52 + prefix * 0.05) : 0;
  return Math.max(editScore, prefixScore);
}

function minimumTokenSimilarity(token: string) {
  if (token.length <= 2) return 1;
  if (token.length === 3) return 2 / 3;
  return 0.6;
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

function relativeRole(type: string, direction: "from" | "to", person: Person) {
  const female = person.sex === "f",
    male = person.sex === "m",
    child = female ? "дочь" : male ? "сын" : "ребёнок";
  if (type === "parent")
    return direction === "from"
      ? female
        ? "мать"
        : male
          ? "отец"
          : "родитель"
      : child;
  if (type === "spouse") return female ? "супруга" : male ? "супруг" : "супруг";
  if (type === "adoptive_parent")
    return direction === "from"
      ? female
        ? "приёмная мать"
        : male
          ? "приёмный отец"
          : "приёмный родитель"
      : child;
  if (type === "step_parent")
    return direction === "from"
      ? female
        ? "мачеха"
        : male
          ? "отчим"
          : "неродной родитель"
      : female
        ? "падчерица"
        : male
          ? "пасынок"
          : "ребёнок супруга";
  if (type === "godparent")
    return direction === "from"
      ? female
        ? "крёстная мать"
        : male
          ? "крёстный отец"
          : "крёстный родитель"
      : female
        ? "крестница"
        : male
          ? "крестник"
          : "крестник";
  if (type === "sworn_sibling")
    return female
      ? "названная сестра"
      : male
        ? "названный брат"
        : "названный родственник";
  if (type === "guardian")
    return direction === "from"
      ? "опекун"
      : female
        ? "подопечная"
        : male
          ? "подопечный"
          : "подопечный";
  if (type === "nurse") return direction === "from" ? "кормилица" : child;
  return type;
}

function cleanPhoto(family: Family, photoId: string) {
  const photo = (family.photos || []).find((item) => item.id === photoId);
  if (!photo) throw new Error("Фотография не найдена или недоступна");
  const people = new Map(family.people.map((person) => [person.id, person]));
  const taggedIds = new Set(photo.tags.map((tag) => tag.personId)),
    documentedRelationships = archiveConnections(family)
      .filter(
        (connection) =>
          taggedIds.has(connection.from) && taggedIds.has(connection.to),
      )
      .flatMap((connection) => {
        const from = people.get(connection.from),
          to = people.get(connection.to);
        return from && to
          ? [
              {
                type: connection.type,
                from: {
                  id: from.id,
                  name: fullName(from),
                  role: relativeRole(connection.type, "from", from),
                },
                to: {
                  id: to.id,
                  name: fullName(to),
                  role: relativeRole(connection.type, "to", to),
                },
              },
            ]
          : [];
      });
  return {
    id: photo.id,
    title: photo.title,
    takenAt: photo.takenAt,
    year: photo.year,
    place: photo.place,
    event: photo.event,
    description: photo.description,
    people: photo.tags.flatMap((tag) => {
      const person = people.get(tag.personId);
      return person
        ? [
            {
              id: person.id,
              name: fullName(person),
              area: {
                x: tag.x,
                y: tag.y,
                width: tag.width,
                height: tag.height,
              },
            },
          ]
        : [];
    }),
    documentedRelationships,
  };
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

function booleanArg(
  args: Record<string, unknown>,
  key: string,
  fallback: boolean,
) {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "boolean")
    throw new Error(`Некорректный параметр ${key}`);
  return value;
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

function enumArg<T extends string>(
  args: Record<string, unknown>,
  key: string,
  values: readonly T[],
  fallback: T,
) {
  const value = args[key];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !values.includes(value as T))
    throw new Error(`Некорректный параметр ${key}`);
  return value as T;
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
  const result: Array<{
    depth: number;
    person: ReturnType<typeof cleanPerson>;
  }> = [];
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

function idsAtDistance(
  starts: Iterable<string>,
  distance: number,
  next: (id: string) => Iterable<string>,
) {
  let frontier = new Set(starts);
  const visited = new Set(frontier);
  for (let level = 0; level < distance; level++) {
    const following = new Set<string>();
    for (const id of frontier)
      for (const relatedId of next(id))
        if (!visited.has(relatedId)) {
          visited.add(relatedId);
          following.add(relatedId);
        }
    frontier = following;
    if (!frontier.size) break;
  }
  return frontier;
}

function missingFor(person: Person) {
  const missing: string[] = [];
  if (!person.birth) missing.push("дата рождения");
  if (!person.birthPlace.trim()) missing.push("место рождения");
  if (!person.patronymic.trim()) missing.push("отчество");
  if (
    !person.sources.length &&
    !(person.events || []).some((e) => e.sources?.length)
  )
    missing.push("источники");
  if (!person.parents.length) missing.push("родители");
  else if (!person.parentageComplete)
    missing.push("полнота сведений о родителях");
  if (person.deceased && !person.death) missing.push("дата смерти");
  return missing;
}

type ResearchBacklogItem = {
  priority: number;
  documentType:
    "birth_or_baptism" | "marriage" | "death_or_burial" | "household_or_census";
  documentLabel: string;
  person: { id: string; name: string };
  branchDepth: number;
  reasons: string[];
  expectedFields: string[];
  clues: string[];
};

function hasSources(person: Person) {
  return (
    person.sources.length > 0 ||
    (person.events || []).some((event) => event.sources?.length) ||
    (person.awards || []).some((award) => award.source)
  );
}

function knownYear(value?: string) {
  const match = value?.match(/(?:^|\D)(\d{4})(?:\D|$)/);
  return match?.[1] || "";
}

function branchPeopleWithDepth(
  family: Family,
  personId: string,
  direction: "ancestors" | "descendants" | "both",
  depth: number,
) {
  const anchor = personOrThrow(family, personId),
    result = new Map<string, { person: Person; depth: number }>([
      [anchor.id, { person: anchor, depth: 0 }],
    ]);
  for (const selectedDirection of ["ancestors", "descendants"] as const) {
    if (
      (direction === "ancestors" && selectedDirection === "descendants") ||
      (direction === "descendants" && selectedDirection === "ancestors")
    )
      continue;
    for (const item of lineage(family, personId, depth, selectedDirection)) {
      const id = String(item.person.id),
        person = family.people.find((candidate) => candidate.id === id);
      if (!person) continue;
      const existing = result.get(id);
      if (!existing || item.depth < existing.depth)
        result.set(id, { person, depth: item.depth });
    }
  }
  return [...result.values()];
}

function backlogForPerson(
  person: Person,
  branchDepth: number,
): ResearchBacklogItem[] {
  const result: ResearchBacklogItem[] = [],
    proximity = Math.max(0, 12 - branchDepth * 2),
    unsourced = !hasSources(person),
    parentsMissing = !person.parents.length || !person.parentageComplete,
    birthYear = knownYear(person.birth),
    deathYear = knownYear(person.death),
    birthPlace = person.birthPlace.trim(),
    deathPlace = person.deathPlace?.trim() || "";

  const add = (
    documentType: ResearchBacklogItem["documentType"],
    documentLabel: string,
    base: number,
    reasons: string[],
    expectedFields: string[],
    clues: string[],
  ) => {
    if (!reasons.length) return;
    result.push({
      priority: Math.min(100, base + proximity),
      documentType,
      documentLabel,
      person: { id: person.id, name: fullName(person) },
      branchDepth,
      reasons,
      expectedFields: [...new Set(expectedFields)],
      clues: [...new Set(clues.filter(Boolean))],
    });
  };

  const birthReasons: string[] = [],
    birthFields: string[] = [];
  let birthScore = 24;
  if (!person.birth) {
    birthReasons.push("неизвестна дата рождения");
    birthFields.push("дата рождения");
    birthScore += 18;
  }
  if (!birthPlace) {
    birthReasons.push("неизвестно место рождения");
    birthFields.push("место рождения");
    birthScore += 12;
  }
  if (parentsMissing) {
    birthReasons.push(
      person.parents.length
        ? "сведения о родителях отмечены как неполные"
        : "родители не установлены",
    );
    birthFields.push("родители");
    birthScore += 30;
  }
  if (!person.patronymic.trim()) {
    birthReasons.push("неизвестно отчество");
    birthFields.push("отчество");
    birthScore += 7;
  }
  if (unsourced) {
    birthReasons.push("в карточке нет источников");
    birthScore += 8;
  }
  if (birthYear) birthScore += 5;
  if (birthPlace) birthScore += 7;
  add(
    "birth_or_baptism",
    "Запись о рождении / крещении",
    birthScore,
    birthReasons,
    birthFields.length
      ? birthFields
      : ["дата рождения", "место рождения", "родители"],
    [birthYear && `год: ${birthYear}`, birthPlace && `место: ${birthPlace}`],
  );

  if (person.spouses.length) {
    const marriageReasons: string[] = [],
      marriageFields = [
        "супруг",
        "возраст на момент брака",
        "место жительства",
      ];
    let marriageScore = 28;
    if (person.sex === "f" && !person.maidenName?.trim()) {
      marriageReasons.push("неизвестна фамилия при рождении");
      marriageFields.push("фамилия при рождении");
      marriageScore += 22;
    }
    if (parentsMissing) {
      marriageReasons.push("родители неизвестны или известны не полностью");
      marriageFields.push("родители");
      marriageScore += 18;
    }
    if (unsourced) {
      marriageReasons.push("семейные сведения не подтверждены источником");
      marriageScore += 8;
    }
    if (birthYear) marriageScore += 3;
    if (birthPlace) marriageScore += 4;
    add(
      "marriage",
      "Запись о браке",
      marriageScore,
      marriageReasons,
      marriageFields,
      [
        birthYear && `год рождения: ${birthYear}`,
        birthPlace && `место происхождения: ${birthPlace}`,
      ],
    );
  }

  if (person.deceased) {
    const deathReasons: string[] = [],
      deathFields: string[] = [];
    let deathScore = 22;
    if (!person.death) {
      deathReasons.push("неизвестна дата смерти");
      deathFields.push("дата смерти");
      deathScore += 28;
    }
    if (!deathPlace) {
      deathReasons.push("неизвестно место смерти");
      deathFields.push("место смерти");
      deathScore += 14;
    }
    if (unsourced) {
      deathReasons.push("сведения не подтверждены источником");
      deathScore += 8;
    }
    if (birthYear) deathScore += 3;
    if (deathYear) deathScore += 5;
    add(
      "death_or_burial",
      "Запись о смерти / погребении",
      deathScore,
      deathReasons,
      deathFields.length
        ? deathFields
        : ["дата смерти", "место смерти", "возраст"],
      [
        birthYear && `год рождения: ${birthYear}`,
        deathYear && `год смерти: ${deathYear}`,
        deathPlace && `место смерти: ${deathPlace}`,
        birthPlace && `место рождения: ${birthPlace}`,
      ],
    );
  }

  if (parentsMissing && (birthYear || birthPlace)) {
    const householdReasons = [
      person.parents.length
        ? "семья происхождения известна не полностью"
        : "не установлены родители",
    ];
    let householdScore = 34;
    if (birthPlace) householdScore += 10;
    if (birthYear) householdScore += 7;
    if (unsourced) householdScore += 5;
    add(
      "household_or_census",
      "Перепись / посемейный список / домовая книга",
      householdScore,
      householdReasons,
      [
        "состав семьи",
        "родство членов хозяйства",
        "возраст",
        "место жительства",
      ],
      [
        birthYear && `ориентир по году рождения: ${birthYear}`,
        birthPlace && `место: ${birthPlace}`,
      ],
    );
  }

  return result;
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

  if (name === "get_surname_group")
    return surnameGroup(family, stringArg(args, "surname"));

  if (name === "get_evidence_coverage" || name === "find_evidence_gaps") {
    const personId = stringArg(args, "personId", false);
    const surname = stringArg(args, "surname", false);
    const surnameIds = surname
      ? new Set(surnameGroup(family, surname).people.map((person) => person.id))
      : null;
    const candidates = personId
      ? [personOrThrow(family, personId)]
      : surnameIds
        ? family.people.filter((person) => surnameIds.has(person.id))
        : family.people;
    const limit = numberArg(
      args,
      "limit",
      name === "find_evidence_gaps" ? 30 : 50,
      1,
      100,
    );
    const records = candidates.map((person) => ({
      person: { id: person.id, name: fullName(person) },
      cardSourceCount: person.sources.length,
      knownFacts: [
        person.birth && "дата рождения",
        person.birthPlace && "место рождения",
        person.death && "дата смерти",
        person.deathPlace && "место смерти",
      ].filter(Boolean),
      events: (person.events || []).map((event) => ({
        id: event.id,
        title: event.title || event.type,
        date: event.date,
        sourceCount: event.sources?.length || 0,
      })),
      awards: (person.awards || []).map((award) => ({
        id: award.id,
        title: award.name,
        sourceCount: award.source ? 1 : 0,
      })),
    }));
    if (name === "get_evidence_coverage")
      return {
        total: records.length,
        records: records.slice(0, limit),
        note: "Источники карточки не привязаны к отдельным полям; автоматически подтвердить конкретный факт по ним нельзя.",
      };
    const gaps = records.flatMap((record) => [
      ...(!record.cardSourceCount && record.knownFacts.length
        ? [{ person: record.person, kind: "card", facts: record.knownFacts }]
        : []),
      ...record.events
        .filter((event) => !event.sourceCount)
        .map((event) => ({
          person: record.person,
          kind: "event",
          item: event,
        })),
      ...record.awards
        .filter((award) => !award.sourceCount)
        .map((award) => ({
          person: record.person,
          kind: "award",
          item: award,
        })),
    ]);
    return {
      total: gaps.length,
      gaps: gaps.slice(0, limit),
      truncated: gaps.length > limit,
    };
  }

  if (name === "list_people") {
    const offset = numberArg(args, "offset", 0, 0, 1_000_000),
      limit = numberArg(args, "limit", 100, 1, 100),
      ordered = [...family.people].sort((a, b) =>
        fullName(a).localeCompare(fullName(b), "ru"),
      );
    return {
      people: ordered.slice(offset, offset + limit).map((person) => ({
        id: person.id,
        name: fullName(person),
        birth: person.birth,
        death: person.death,
        birthPlace: person.birthPlace,
      })),
      offset,
      limit,
      total: ordered.length,
      hasMore: offset + limit < ordered.length,
    };
  }

  if (name === "search_people") {
    const query = normalized(stringArg(args, "query")),
      searchablePeople = family.people.map((person) => {
        const fields = [
            fullName(person),
            person.maidenName || "",
            person.birth || "",
            person.death || "",
            person.birthPlace,
            person.deathPlace || "",
          ].map(normalized),
          tokens = fields.flatMap(searchTokens);
        return { person, fields, tokens };
      }),
      archiveTokens = [
        ...new Set(searchablePeople.flatMap((item) => item.tokens)),
      ],
      similarityCache = new Map<string, number>(),
      similarity = (left: string, right: string) => {
        const key = `${left}\0${right}`;
        let value = similarityCache.get(key);
        if (value === undefined) {
          value = tokenSimilarity(left, right);
          similarityCache.set(key, value);
        }
        return value;
      },
      queryTokens = searchTokens(query)
        .filter((token) => token.length >= 2)
        .slice(0, 16)
        .filter((token) =>
          archiveTokens.some(
            (archiveToken) =>
              similarity(token, archiveToken) >= minimumTokenSimilarity(token),
          ),
        ),
      limit = numberArg(args, "limit", 20, 1, 50);
    const matches = searchablePeople
      .map(({ person, fields, tokens }) => {
        let score = fields.reduce(
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
        const similarities = queryTokens.map((token) =>
            tokens.reduce(
              (best, fieldToken) =>
                Math.max(best, similarity(token, fieldToken)),
              0,
            ),
          ),
          matching = similarities.filter(
            (similarity, index) =>
              similarity >= minimumTokenSimilarity(queryTokens[index]),
          ),
          completeMatch =
            similarities.length > 0 && matching.length === similarities.length;
        if (completeMatch)
          score = Math.max(
            score,
            (matching.reduce((sum, value) => sum + value, 0) /
              matching.length) *
              80 +
              Math.min(16, matching.length * 4),
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
      children = family.people.filter((item) =>
        item.parents.includes(person.id),
      ),
      parentIds = new Set(person.parents),
      siblings = family.people.flatMap((candidate) => {
        if (candidate.id === person.id) return [];
        const sharedParentIds = candidate.parents.filter((id) =>
          parentIds.has(id),
        );
        if (!sharedParentIds.length) return [];
        return [
          {
            person: cleanPerson(candidate),
            sharedParentIds,
            kind: sharedParentIds.length >= 2 ? "full" : "half_or_unknown",
          },
        ];
      });
    return {
      person: cleanPerson(person),
      parents: person.parents.flatMap((id) =>
        people.has(id) ? [cleanPerson(people.get(id)!)] : [],
      ),
      spouses: person.spouses.flatMap((id) =>
        people.has(id) ? [cleanPerson(people.get(id)!)] : [],
      ),
      children: children.map(cleanPerson),
      siblings,
    };
  }

  if (name === "get_cousins") {
    const person = personOrThrow(family, stringArg(args, "personId")),
      degree = numberArg(args, "degree", 2, 2, 10),
      limit = numberArg(args, "limit", 100, 1, 100),
      people = new Map(family.people.map((item) => [item.id, item])),
      children = new Map<string, string[]>();
    for (const child of family.people)
      for (const parentId of child.parents) {
        if (!people.has(parentId)) continue;
        const ids = children.get(parentId) || [];
        ids.push(child.id);
        children.set(parentId, ids);
      }
    const ancestors = idsAtDistance(
        [person.id],
        degree,
        (id) => people.get(id)?.parents || [],
      ),
      candidates = new Set<string>();
    for (const ancestorId of ancestors)
      for (const candidateId of idsAtDistance(
        [ancestorId],
        degree,
        (id) => children.get(id) || [],
      ))
        if (candidateId !== person.id) candidates.add(candidateId);

    const relatives = [...candidates]
      .flatMap((candidateId) => {
        const candidate = people.get(candidateId);
        if (!candidate) return [];
        const relation = analyzeKinship(
          candidate,
          person,
          family.people,
          family.links,
        );
        if (
          relation.kind !== "blood" ||
          relation.distances?.[0] !== degree ||
          relation.distances[1] !== degree ||
          !relation.roles?.[0]
        )
          return [];
        return [
          {
            person: {
              id: candidate.id,
              name: fullName(candidate),
              birth: candidate.birth,
              death: candidate.death,
            },
            term: relation.roles[0].term,
            description: relation.roles[0].description,
            commonAncestors: relation.common.flatMap((id) => {
              const ancestor = people.get(id);
              return ancestor ? [{ id, name: fullName(ancestor) }] : [];
            }),
            path: relation.path.flatMap((id) => {
              const pathPerson = people.get(id);
              return pathPerson ? [{ id, name: fullName(pathPerson) }] : [];
            }),
          },
        ];
      })
      .sort((left, right) =>
        left.person.name.localeCompare(right.person.name, "ru"),
      );
    return {
      person: { id: person.id, name: fullName(person) },
      degree,
      relatives: relatives.slice(0, limit),
      total: relatives.length,
      hasMore: relatives.length > limit,
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

  if (name === "search_photos") {
    const query = normalized(stringArg(args, "query", false)),
      personId = stringArg(args, "personId", false),
      limit = numberArg(args, "limit", 20, 1, 50),
      people = new Map(family.people.map((person) => [person.id, person]));
    if (personId) personOrThrow(family, personId);
    const photos = (family.photos || [])
      .filter(
        (photo) =>
          !personId || photo.tags.some((tag) => tag.personId === personId),
      )
      .filter((photo) => {
        if (!query) return true;
        const fields = [
          photo.title,
          photo.takenAt || "",
          photo.year || "",
          photo.place || "",
          photo.event || "",
          photo.description || "",
          ...photo.tags.flatMap((tag) => {
            const person = people.get(tag.personId);
            return person ? [fullName(person)] : [];
          }),
        ];
        const joined = fields.map(normalized).join(" ");
        return query.split(" ").every((token) => joined.includes(token));
      })
      .slice(0, limit)
      .map((photo) => cleanPhoto(family, photo.id));
    return { photos, total: photos.length };
  }

  if (name === "get_photo")
    return { photo: cleanPhoto(family, stringArg(args, "photoId")) };

  if (name === "search_archive") {
    const query = normalized(stringArg(args, "query")),
      tokens = query.split(" "),
      limit = numberArg(args, "limit", 25, 1, 50),
      contains = (values: Array<string | undefined>) => {
        const joined = normalized(values.filter(Boolean).join(" "));
        return tokens.every((token) => joined.includes(token));
      },
      matches: Array<Record<string, unknown>> = [];
    for (const person of family.people) {
      if (
        contains([
          fullName(person),
          person.maidenName,
          person.birth,
          person.death,
          person.birthPlace,
          person.deathPlace,
          person.occupation,
          person.biography,
        ])
      )
        matches.push({
          kind: "person",
          person: {
            id: person.id,
            name: fullName(person),
            birth: person.birth,
            death: person.death,
          },
          occupation: person.occupation,
          biography: person.biography,
        });
      for (const event of person.events || [])
        if (
          contains([
            event.type,
            event.title,
            event.date,
            event.dateText,
            event.place,
            event.description,
          ])
        )
          matches.push({
            kind: "event",
            person: { id: person.id, name: fullName(person) },
            event: Object.fromEntries(
              Object.entries(event).filter(([key]) => key !== "sources"),
            ),
          });
      for (const award of person.awards || [])
        if (contains([award.name, award.year, award.degreeId]))
          matches.push({
            kind: "award",
            person: { id: person.id, name: fullName(person) },
            award: Object.fromEntries(
              Object.entries(award).filter(([key]) => key !== "source"),
            ),
          });
      for (const source of person.sources)
        if (
          contains([source.title, source.type, source.reference, source.note])
        )
          matches.push({
            kind: "source",
            person: { id: person.id, name: fullName(person) },
            source,
          });
    }
    for (const photo of family.photos || [])
      if (
        contains([
          photo.title,
          photo.takenAt,
          photo.year,
          photo.place,
          photo.event,
          photo.description,
        ])
      )
        matches.push({ kind: "photo", photo: cleanPhoto(family, photo.id) });
    return {
      matches: matches.slice(0, limit),
      total: matches.length,
      truncated: matches.length > limit,
    };
  }

  if (name === "get_timeline") {
    const personId = stringArg(args, "personId", false),
      limit = numberArg(args, "limit", 100, 1, 100),
      candidates = personId ? [personOrThrow(family, personId)] : family.people,
      candidateIds = new Set(candidates.map((person) => person.id)),
      items: Array<Record<string, unknown> & { date: string }> = [];
    for (const person of candidates) {
      if (person.birth)
        items.push({
          kind: "birth",
          date: person.birth,
          person: { id: person.id, name: fullName(person) },
          place: person.birthPlace,
        });
      if (person.death)
        items.push({
          kind: "death",
          date: person.death,
          person: { id: person.id, name: fullName(person) },
          place: person.deathPlace,
        });
      for (const event of person.events || []) {
        const date = event.date || event.dateText || "";
        if (date)
          items.push({
            kind: "event",
            date,
            person: { id: person.id, name: fullName(person) },
            event: Object.fromEntries(
              Object.entries(event).filter(([key]) => key !== "sources"),
            ),
          });
      }
    }
    for (const photo of family.photos || []) {
      const date = photo.takenAt || photo.year || "";
      if (
        date &&
        (!personId || photo.tags.some((tag) => candidateIds.has(tag.personId)))
      )
        items.push({
          kind: "photo",
          date,
          photo: cleanPhoto(family, photo.id),
        });
    }
    items.sort((a, b) => a.date.localeCompare(b.date, "ru"));
    return {
      items: items.slice(0, limit),
      total: items.length,
      truncated: items.length > limit,
    };
  }

  if (name === "get_genealogy_graph") {
    const personId = stringArg(args, "personId"),
      direction = enumArg(
        args,
        "direction",
        ["ancestors", "descendants", "both"] as const,
        "both",
      ),
      depth = numberArg(args, "depth", 3, 1, 6),
      includeSpouses = booleanArg(args, "includeSpouses", true),
      includeExtra = booleanArg(args, "includeExtraRelations", true),
      ids = new Set([personId]);
    personOrThrow(family, personId);
    if (direction !== "descendants")
      for (const item of lineage(family, personId, depth, "ancestors"))
        ids.add(String(item.person.id));
    if (direction !== "ancestors")
      for (const item of lineage(family, personId, depth, "descendants"))
        ids.add(String(item.person.id));
    if (includeSpouses)
      for (const person of family.people)
        if (ids.has(person.id))
          for (const spouseId of person.spouses) ids.add(spouseId);
    const nodes = family.people
        .filter((person) => ids.has(person.id))
        .map((person) => ({
          id: person.id,
          name: fullName(person),
          birth: person.birth,
          death: person.death,
          sex: person.sex,
        })),
      edges: Array<{
        from: string;
        to: string;
        type: string;
        note?: string;
      }> = [],
      spouseKeys = new Set<string>();
    for (const person of family.people.filter((item) => ids.has(item.id))) {
      for (const parentId of person.parents)
        if (ids.has(parentId))
          edges.push({ from: parentId, to: person.id, type: "parent" });
      if (includeSpouses)
        for (const spouseId of person.spouses)
          if (ids.has(spouseId)) {
            const pair = [person.id, spouseId].sort(),
              key = pair.join("\0");
            if (!spouseKeys.has(key)) {
              spouseKeys.add(key);
              edges.push({ from: pair[0], to: pair[1], type: "spouse" });
            }
          }
    }
    if (includeExtra)
      for (const link of family.links || [])
        if (ids.has(link.from) && ids.has(link.to))
          edges.push({
            from: link.from,
            to: link.to,
            type: link.type,
            note: link.note,
          });
    return {
      anchorId: personId,
      direction,
      depth,
      nodes,
      edges,
      mermaid: graphMermaid(nodes, edges),
    };
  }

  if (name === "get_place_summary") {
    const query = normalized(stringArg(args, "query")),
      limit = numberArg(args, "limit", 50, 1, 100),
      matches: Array<Record<string, unknown>> = [],
      has = (value?: string) =>
        Boolean(value && normalized(value).includes(query));
    for (const person of family.people) {
      const personRef = { id: person.id, name: fullName(person) };
      if (has(person.birthPlace))
        matches.push({
          kind: "birth",
          person: personRef,
          place: person.birthPlace,
        });
      if (has(person.deathPlace))
        matches.push({
          kind: "death",
          person: personRef,
          place: person.deathPlace,
        });
      for (const event of person.events || [])
        if (has(event.place))
          matches.push({
            kind: "event",
            person: personRef,
            place: event.place,
            date: event.date || event.dateText,
            title: event.title || event.type,
          });
    }
    for (const photo of family.photos || [])
      if (has(photo.place))
        matches.push({ kind: "photo", photo: cleanPhoto(family, photo.id) });
    return {
      query,
      matches: matches.slice(0, limit),
      total: matches.length,
      truncated: matches.length > limit,
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

  if (name === "find_possible_duplicates") {
    const requested = stringArg(args, "personId", false),
      limit = numberArg(args, "limit", 30, 1, 100);
    return findPossibleDuplicates(family.people, requested || undefined, limit);
  }

  if (name === "get_branch_insights") {
    const personId = stringArg(args, "personId"),
      direction = enumArg(
        args,
        "direction",
        ["ancestors", "descendants", "both"] as const,
        "ancestors",
      ),
      depth = numberArg(args, "depth", 4, 1, 8),
      anchor = personOrThrow(family, personId),
      ancestorIds =
        direction === "descendants"
          ? []
          : lineage(family, personId, depth, "ancestors").map((item) =>
              String(item.person.id),
            ),
      descendantIds =
        direction === "ancestors"
          ? []
          : lineage(family, personId, depth, "descendants").map((item) =>
              String(item.person.id),
            ),
      branchIds = new Set([personId, ...ancestorIds, ...descendantIds]),
      branchPeople = family.people.filter((person) => branchIds.has(person.id)),
      missing = branchPeople
        .map((person) => ({ person, missing: missingFor(person) }))
        .filter((item) => item.missing.length)
        .sort(
          (a, b) =>
            b.missing.length - a.missing.length ||
            fullName(a.person).localeCompare(fullName(b.person), "ru"),
        ),
      warnings = analyzeFamilyInsights(family).warnings.filter((warning) =>
        warning.personIds.some((id) => branchIds.has(id)),
      ),
      people = new Map(family.people.map((person) => [person.id, person])),
      withSources = branchPeople.filter(
        (person) =>
          person.sources.length > 0 ||
          (person.events || []).some((event) => event.sources?.length) ||
          (person.awards || []).some((award) => award.source),
      ).length;
    return {
      anchor: { id: anchor.id, name: fullName(anchor) },
      direction,
      depth,
      totals: {
        people: branchPeople.length,
        knownBirthDates: branchPeople.filter((person) => person.birth).length,
        knownBirthPlaces: branchPeople.filter((person) =>
          person.birthPlace.trim(),
        ).length,
        withSources,
        completeParentage: branchPeople.filter(
          (person) => person.parentageComplete === true,
        ).length,
      },
      missing: missing.slice(0, 25).map(({ person, missing: fields }) => ({
        id: person.id,
        name: fullName(person),
        missing: fields,
      })),
      warnings: warnings.map((warning) => ({
        ...warning,
        people: warning.personIds.flatMap((id) =>
          people.has(id) ? [{ id, name: fullName(people.get(id)!) }] : [],
        ),
      })),
    };
  }

  if (name === "get_research_backlog") {
    const requested = stringArg(args, "personId", false),
      direction = enumArg(
        args,
        "direction",
        ["ancestors", "descendants", "both"] as const,
        "ancestors",
      ),
      depth = numberArg(args, "depth", 4, 1, 8),
      limit = numberArg(args, "limit", 12, 1, 50),
      candidates = requested
        ? branchPeopleWithDepth(family, requested, direction, depth)
        : family.people.map((person) => ({ person, depth: 0 })),
      items = candidates
        .flatMap(({ person, depth: branchDepth }) =>
          backlogForPerson(person, branchDepth),
        )
        .sort(
          (a, b) =>
            b.priority - a.priority ||
            a.branchDepth - b.branchDepth ||
            a.person.name.localeCompare(b.person.name, "ru") ||
            a.documentLabel.localeCompare(b.documentLabel, "ru"),
        )
        .slice(0, limit);
    return {
      ...(requested
        ? {
            anchor: {
              id: requested,
              name: fullName(personOrThrow(family, requested)),
            },
            direction,
            depth,
          }
        : {}),
      items,
      total: items.length,
      scoring:
        "Приоритет вычисляется из числа и ценности закрываемых пробелов, наличия поисковых ориентиров и близости к выбранному человеку.",
    };
  }

  if (name === "get_archive_insights") {
    const insights = analyzeFamilyInsights(family);
    return {
      totals: insights.totals,
      completeness: insights.completeness,
      generationDistribution: insights.generations,
      facts: insights.facts,
      topSurnames: insights.topSurnames,
      topNames: insights.topNames,
    };
  }

  throw new Error("Неизвестный исследовательский инструмент");
}
