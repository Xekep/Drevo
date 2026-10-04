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
import type { StoreDatabase } from "./store-database.ts";
import type { ArchiveUser } from "../domain/access.ts";
import { auditStore } from "./audit.ts";
import type pg from "pg";
import { assertCurrentPlatformAdmin } from "./platform-access.ts";

type PlatformSession = { accountId: string; tokenHash: string };

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

export function researchCatalogStore(db: StoreDatabase) {
  const audit = auditStore(db);
  async function list(): Promise<ResearchCategory[]> {
    const categories = await db
      .prepare(
        "SELECT id,name FROM research_categories ORDER BY sort_order,id",
        "SELECT id,name FROM platform_research_categories ORDER BY sort_order,id",
      )
      .all();
    const resources = await db
      .prepare(
        "SELECT id,category_id,name,url,description,ai_search FROM research_resources ORDER BY category_id,sort_order,id",
        "SELECT id,category_id,name,url,description,ai_search::text AS ai_search FROM platform_research_resources ORDER BY category_id,sort_order,id",
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

  async function write(
    action: string,
    entityId: string,
    label: string,
    actor: ArchiveUser | null,
    session: PlatformSession | undefined,
    run: (client?: pg.PoolClient) => void | Promise<void>,
  ) {
    if (db.kind === "postgres") {
      if (!session || !db.postgresTransaction) throw new Error("Сеанс завершён");
      await db.postgresTransaction(async (client) => {
        await assertCurrentPlatformAdmin(client, session.accountId, session.tokenHash);
        await run(client);
        await client.query(
          `INSERT INTO platform_config_audit(actor_id,action,item_id)
           VALUES($1,$2,$3)`,
          [session.accountId, action, entityId],
        );
      });
      return;
    }
    if (!actor) throw new Error("Сеанс завершён");
    return await db.transaction(async () => {
      await run();
      await audit.record(
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
    });
  }

  async function existing(
    table: "research_categories" | "research_resources",
    id: string,
  ) {
    const row = await db
      .prepare(
        `SELECT * FROM ${table} WHERE id=?`,
        `SELECT * FROM platform_${table} WHERE id=?`,
      )
      .get(id);
    if (!row) throw new RangeError("Запись не найдена");
    return row;
  }

  return {
    list,
    webSearchSources: async () =>
      (await list()).flatMap((category) => category.resources),
    categoryNames: async () =>
      (
        await db
          .prepare(
            "SELECT name FROM research_categories ORDER BY sort_order,id",
            "SELECT name FROM platform_research_categories ORDER BY sort_order,id",
          )
          .all()
      ).map((row) => String(row.name)),
    async search(categoryName: string, query = "") {
      const category = (await list()).find(
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
    async searchAny(query: string, categoryName = "") {
      const words = searchWords(query);
      if (!words.length)
        return {
          resources: [] as Array<ResearchResource & { category: string }>,
        };
      const categories = (await list()).filter(
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
    async createCategory(value: unknown, actor: ArchiveUser | null,
      session?: PlatformSession) {
      const name = requiredText(
        (value as Record<string, unknown>)?.name,
        "Категория",
        100,
      );
      const id = randomUUID();
      await write("Добавлена категория поиска", id, name, actor, session, async (client) => {
        if (client) await client.query(
          `INSERT INTO platform_research_categories(id,name,sort_order)
           VALUES($1,$2,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM platform_research_categories))`,
          [id, name],
        );
        else await db
          .prepare(
            "INSERT INTO research_categories(id,name,sort_order) VALUES(?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM research_categories))",
            "INSERT INTO research_categories(id,name,sort_order) VALUES(?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM research_categories))",
          )
          .run(id, name);
      });
      return await list();
    },
    async updateCategory(id: string, value: unknown, actor: ArchiveUser | null,
      session?: PlatformSession) {
      await existing("research_categories", id);
      const name = requiredText(
        (value as Record<string, unknown>)?.name,
        "Категория",
        100,
      );
      await write("Изменена категория поиска", id, name, actor, session, async (client) => {
        if (client) {
          const result = await client.query(
            "UPDATE platform_research_categories SET name=$1 WHERE id=$2",
            [name, id],
          );
          if (!result.rowCount) throw new RangeError("Запись не найдена");
        }
        else await db
          .prepare(
            "UPDATE research_categories SET name=? WHERE id=?",
            "UPDATE research_categories SET name=? WHERE id=?",
          )
          .run(name, id);
      });
      return await list();
    },
    async deleteCategory(id: string, actor: ArchiveUser | null,
      session?: PlatformSession) {
      const row = await existing("research_categories", id);
      await write(
        "Удалена категория поиска",
        id,
        String(row.name),
        actor,
        session,
        async (client) => {
          if (client) {
            const result = await client.query(
              "DELETE FROM platform_research_categories WHERE id=$1",
              [id],
            );
            if (!result.rowCount) throw new RangeError("Запись не найдена");
          }
          else await db
            .prepare(
              "DELETE FROM research_categories WHERE id=?",
              "DELETE FROM research_categories WHERE id=?",
            )
            .run(id);
        },
      );
      return await list();
    },
    async createResource(
      categoryId: string,
      value: unknown,
      actor: ArchiveUser | null,
      session?: PlatformSession,
    ) {
      const category = await existing("research_categories", categoryId);
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
      await write("Добавлен ресурс поиска", id, name, actor, session, async (client) => {
        if (client) await client.query(
          `INSERT INTO platform_research_resources
             (id,category_id,name,url,description,ai_search,sort_order)
           VALUES($1,$2,$3,$4,$5,$6,
             (SELECT COALESCE(MAX(sort_order),-1)+1
                FROM platform_research_resources WHERE category_id=$2))`,
          [id, categoryId, name, url, description, JSON.stringify(search)],
        );
        else await db
          .prepare(
            "INSERT INTO research_resources(id,category_id,name,url,description,ai_search,sort_order) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM research_resources WHERE category_id=?))",
            "INSERT INTO research_resources(id,category_id,name,url,description,ai_search,sort_order) VALUES(?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM research_resources WHERE category_id=?))",
          )
          .run(
            id,
            categoryId,
            name,
            url,
            description,
            JSON.stringify(search),
            categoryId,
          );
      });
      return await list();
    },
    async updateResource(id: string, value: unknown, actor: ArchiveUser | null,
      session?: PlatformSession) {
      const before = (await list())
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
      await write("Изменён ресурс поиска", id, name, actor, session, async (client) => {
        if (client) {
          const result = await client.query(
            `UPDATE platform_research_resources
             SET name=$1,url=$2,description=$3,ai_search=$4 WHERE id=$5`,
            [name, url, description, JSON.stringify(search), id],
          );
          if (!result.rowCount) throw new RangeError("Запись не найдена");
        }
        else await db
          .prepare(
            "UPDATE research_resources SET name=?,url=?,description=?,ai_search=? WHERE id=?",
            "UPDATE research_resources SET name=?,url=?,description=?,ai_search=? WHERE id=?",
          )
          .run(name, url, description, JSON.stringify(search), id);
      });
      return await list();
    },
    async deleteResource(id: string, actor: ArchiveUser | null,
      session?: PlatformSession) {
      const row = await existing("research_resources", id);
      await write(
        "Удалён ресурс поиска",
        id,
        String(row.name),
        actor,
        session,
        async (client) => {
          if (client) {
            const result = await client.query(
              "DELETE FROM platform_research_resources WHERE id=$1",
              [id],
            );
            if (!result.rowCount) throw new RangeError("Запись не найдена");
          }
          else await db
            .prepare(
              "DELETE FROM research_resources WHERE id=?",
              "DELETE FROM research_resources WHERE id=?",
            )
            .run(id);
        },
      );
      return await list();
    },
  };
}
