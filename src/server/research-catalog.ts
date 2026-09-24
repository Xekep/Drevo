import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ArchiveUser } from "../domain/access.ts";
import { auditStore } from "./audit.ts";

export type ResearchResource = {
  id: string;
  categoryId: string;
  name: string;
  url: string;
  description: string;
};
export type ResearchCategory = {
  id: string;
  name: string;
  resources: ResearchResource[];
};

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
        "SELECT id,category_id,name,url,description FROM research_resources ORDER BY category_id,sort_order,id",
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
        const score = words.reduce(
          (sum, word) =>
            sum +
            (title.includes(word) ? 4 : 0) +
            (description.includes(word) ? 1 : 0),
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
      existing("research_categories", categoryId);
      const item = value as Record<string, unknown>;
      const name = requiredText(item?.name, "Название", 160);
      const url = resourceUrl(item?.url);
      const description = requiredText(
        item?.description,
        "Описание",
        500,
        true,
      );
      const id = randomUUID();
      write("Добавлен ресурс поиска", id, name, actor, () => {
        db.prepare(
          "INSERT INTO research_resources(id,category_id,name,url,description,sort_order) VALUES(?,?,?,?,?,(SELECT COALESCE(MAX(sort_order),-1)+1 FROM research_resources WHERE category_id=?))",
        ).run(id, categoryId, name, url, description, categoryId);
      });
      return list();
    },
    updateResource(id: string, value: unknown, actor: ArchiveUser) {
      existing("research_resources", id);
      const item = value as Record<string, unknown>;
      const name = requiredText(item?.name, "Название", 160);
      const url = resourceUrl(item?.url);
      const description = requiredText(
        item?.description,
        "Описание",
        500,
        true,
      );
      write("Изменён ресурс поиска", id, name, actor, () => {
        db.prepare(
          "UPDATE research_resources SET name=?,url=?,description=? WHERE id=?",
        ).run(name, url, description, id);
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
