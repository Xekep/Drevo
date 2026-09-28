import type {
  ResearchCategory,
  ResearchResource,
} from "../shared/research-catalog.ts";
export type {
  ResearchCategory,
  ResearchResource,
} from "../shared/research-catalog.ts";
import {
  defaultSearchSettings,
  validateSearchSettings,
} from "./web-search-sources.ts";
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser } from "../domain/access.ts";
import { auditStore } from "./audit.ts";

const ignoredSearchWords = new Set([
  "дай",
  "мне",
  "покажи",
  "найди",
  "пришли",
  "скинь",
  "где",
  "искать",
  "ссылку",
  "ссылки",
  "сайт",
  "сайты",
  "ресурс",
  "ресурсы",
  "пожалуйста",
]);

function searchWords(value: string) {
  return [
    ...new Set(
      (
        value
          .toLocaleLowerCase("ru-RU")
          .replaceAll("ё", "е")
          .match(/[\p{L}\p{N}]{3,}/gu) || []
      ).filter((word) => !ignoredSearchWords.has(word)),
    ),
  ];
}

function wordsMatch(query: string, candidate: string) {
  if (query === candidate) return true;
  const shared = Math.min(query.length, candidate.length);
  if (shared < 5 || Math.abs(query.length - candidate.length) > 3) return false;
  return (
    query.slice(0, Math.max(4, shared - 2)) ===
    candidate.slice(0, Math.max(4, shared - 2))
  );
}

function containsWord(words: string[], query: string) {
  return words.some((word) => wordsMatch(query, word));
}

function requiredText(
  value: unknown,
  label: string,
  max: number,
  allowNewlines = false,
) {
  if (typeof value !== "string")
    throw new RangeError(`${label}: укажите текст`);
  const text = value.trim();
  if (
    !text ||
    text.length > max ||
    [...text].some((char) => {
      const code = char.charCodeAt(0);
      return (
        (code < 32 && !(allowNewlines && (code === 10 || code === 13))) ||
        code === 127
      );
    })
  )
    throw new RangeError(`${label}: от 1 до ${max} символов`);
  return text;
}

function resourceUrl(value: unknown) {
  const text = requiredText(value, "Ссылка", 2048);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new RangeError("Укажите полный адрес сайта");
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !url.hostname ||
    url.username ||
    url.password
  )
    throw new RangeError("Ссылка должна вести на сайт по HTTP или HTTPS");
  return url.href;
}

export function researchCatalogStore(db: DatabaseSync) {
  const audit = auditStore(db);
  function list(): ResearchCategory[] {
    const categories = db
      .prepare("SELECT id,name FROM research_categories ORDER BY sort_order,id")
      .all();
    const resources = db
      .prepare(
        "SELECT id,category_id,name,url,description,ai_search FROM research_resources ORDER BY category_id,sort_order,id",
      )
      .all();
    return categories.map((category) => ({
      id: String(category.id),
      name: String(category.name),
      resources: resources
        .filter((item) => item.category_id === category.id)
        .map((item) => ({
          id: String(item.id),
          categoryId: String(item.category_id),
          name: String(item.name),
          url: String(item.url),
          description: String(item.description),
          ...validateSearchSettings(
            item.ai_search ? JSON.parse(String(item.ai_search)) : {},
            defaultSearchSettings(
              String(item.url),
              String(category.name),
              `${item.name} ${item.description}`,
            ),
          ),
        })),
    }));
  }

  function write(
    action: string,
    entityId: string,
    label: string,
    actor: ArchiveUser,
    run: () => void,
  ) {
    db.exec("BEGIN IMMEDIATE");
    try {
      run();
      audit.record(
        {
          action,
          entity: "research_resource",
          entityId,
          label,
          personIds: [],
          details: [],
        },
        actor,
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function existing(
    table: "research_categories" | "research_resources",
    id: string,
  ) {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    if (!row) throw new RangeError("Запись не найдена");
    return row;
  }

  return {
    list,
    webSearchSources: () => list().flatMap((category) => category.resources),
    categoryNames: () =>
      db
        .prepare("SELECT name FROM research_categories ORDER BY sort_order,id")
        .all()
        .map((row) => String(row.name)),
    search(categoryName: string, query = "") {
      const category = list().find(
        (item) =>
          item.name.toLocaleLowerCase("ru-RU") ===
          categoryName.trim().toLocaleLowerCase("ru-RU"),
      );
      if (!category) return { category: categoryName, resources: [] };
      const words = (
        query.toLocaleLowerCase("ru-RU").match(/[\p{L}\p{N}]{3,}/gu) || []
      ).filter((word) => word !== "вов");
      const scored = category.resources.map((resource, index) => {
        const title = resource.name.toLocaleLowerCase("ru-RU");
        const description = resource.description.toLocaleLowerCase("ru-RU");
        const titleWords = searchWords(title);
        const descriptionWords = searchWords(description);
        const score = words.reduce(
          (sum, word) =>
            sum +
            (title.includes(word)
              ? 4
              : containsWord(titleWords, word)
                ? 3
                : 0) +
            (description.includes(word)
              ? 1
              : containsWord(descriptionWords, word)
                ? 1
                : 0),
          0,
        );
        return { resource, index, score };
      });
      scored.sort((a, b) => b.score - a.score || a.index - b.index);
      return {
        category: category.name,
        resources: scored.slice(0, 5).map(({ resource }) => resource),
      };
    },
    searchAny(query: string, categoryName = "") {
      const words = searchWords(query);
      if (!words.length)
        return {
          resources: [] as Array<ResearchResource & { category: string }>,
        };
      const categories = list().filter(
        (category) =>
          !categoryName ||
          category.name.toLocaleLowerCase("ru-RU") ===
            categoryName.trim().toLocaleLowerCase("ru-RU"),
      );
      const indexed = categories.flatMap((category) =>
        category.resources.map((resource) => ({
          ...resource,
          category: category.name,
          nameWords: searchWords(resource.name),
          descriptionWords: searchWords(resource.description),
          categoryWords: searchWords(category.name),
        })),
      );
      const frequencies = new Map(
        words.map((word) => [
          word,
          indexed.filter(
            (resource) =>
              containsWord(resource.nameWords, word) ||
              containsWord(resource.descriptionWords, word) ||
              containsWord(resource.categoryWords, word),
          ).length,
        ]),
      );
      return {
        resources: indexed
          .map((resource, index) => ({
            resource,
            index,
            score: words.reduce((sum, word) => {
              const weight = 1 / Math.max(1, frequencies.get(word) || 1);
              return (
                sum +
                weight *
                  (containsWord(resource.nameWords, word)
                    ? 9
                    : containsWord(resource.descriptionWords, word)
                      ? 4
                      : containsWord(resource.categoryWords, word)
                        ? 1
                        : 0)
              );
            }, 0),
          }))
          .filter((item) => item.score > 0)
          .sort((a, b) => b.score - a.score || a.index - b.index)
          .slice(0, 5)
          .map(({ resource }) => ({
            id: resource.id,
            categoryId: resource.categoryId,
            category: resource.category,
            name: resource.name,
            url: resource.url,
            description: resource.description,
          })),
      };
    },
    createCategory(value: unknown, actor: ArchiveUser) {
      const name = requiredText(
        (value as Record<string, unknown>)?.name,
        "Категория",
        100,
      );
      const id = randomUUID();
      write("Добавлена категория поиска", id, name, actor, () => {
        db.prepare(
          "INSERT INTO research_categories(id,name,sort_order) VALUES(?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM research_categories))",
        ).run(id, name);
      });
      return list();
    },
    updateCategory(id: string, value: unknown, actor: ArchiveUser) {
      existing("research_categories", id);
      const name = requiredText(
        (value as Record<string, unknown>)?.name,
        "Категория",
        100,
      );
      write("Изменена категория поиска", id, name, actor, () => {
        db.prepare("UPDATE research_categories SET name=? WHERE id=?").run(
          name,
          id,
        );
      });
      return list();
    },
    deleteCategory(id: string, actor: ArchiveUser) {
      const row = existing("research_categories", id);
      write("Удалена категория поиска", id, String(row.name), actor, () => {
        db.prepare("DELETE FROM research_categories WHERE id=?").run(id);
      });
      return list();
    },
    createResource(categoryId: string, value: unknown, actor: ArchiveUser) {
      const category = existing("research_categories", categoryId);
      const item = value as Record<string, unknown>;
      const name = requiredText(item?.name, "Название", 160);
      const url = resourceUrl(item?.url);
      const description = requiredText(
        item?.description,
        "Описание",
        500,
        true,
      );
      const search = validateSearchSettings(
        item,
        defaultSearchSettings(
          url,
          String(category.name),
          `${name} ${description}`,
        ),
      );
      const id = randomUUID();
      write("Добавлен ресурс поиска", id, name, actor, () => {
        db.prepare(
          "INSERT INTO research_resources(id,category_id,name,url,description,ai_search,sort_order) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM research_resources WHERE category_id=?))",
        ).run(
          id,
          categoryId,
          name,
          url,
          description,
          JSON.stringify(search),
          categoryId,
        );
      });
      return list();
    },
    updateResource(id: string, value: unknown, actor: ArchiveUser) {
      const before = list()
        .flatMap((category) => category.resources)
        .find((resource) => resource.id === id);
      if (!before) throw new RangeError("Запись не найдена");
      const item = value as Record<string, unknown>;
      const name = requiredText(item?.name, "Название", 160);
      const url = resourceUrl(item?.url);
      const description = requiredText(
        item?.description,
        "Описание",
        500,
        true,
      );
      const search = validateSearchSettings(item, before);
      write("Изменён ресурс поиска", id, name, actor, () => {
        db.prepare(
          "UPDATE research_resources SET name=?,url=?,description=?,ai_search=? WHERE id=?",
        ).run(name, url, description, JSON.stringify(search), id);
      });
      return list();
    },
    deleteResource(id: string, actor: ArchiveUser) {
      const row = existing("research_resources", id);
      write("Удалён ресурс поиска", id, String(row.name), actor, () => {
        db.prepare("DELETE FROM research_resources WHERE id=?").run(id);
      });
      return list();
    },
  };
}
