import { archiveFetch } from "../data/archive-fetch.ts";
import type { ResearchSearchSettings } from "../shared/web-search.ts";
import type {
  ResearchCategory as Category,
  ResearchResource as Resource,
} from "../shared/research-catalog.ts";
import { useEffect, useState, type FormEvent } from "react";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import "../styles/research-resources-admin.css";

type ResourceDraft = Pick<Resource, "name" | "url" | "description"> &
  ResearchSearchSettings;
const emptyDraft: ResourceDraft = {
  name: "",
  url: "",
  description: "",
  domain: "",
  enabledForAiSearch: true,
  categories: [],
  priority: 0,
};
const endpoint = "/api/admin/research-resources";

function resourceHost(resource: Resource) {
  if (resource.domain) return resource.domain;
  try {
    return new URL(resource.url).hostname;
  } catch {
    return resource.url;
  }
}

export function ResearchResourcesAdmin() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [categoryId, setCategoryId] = useState("");
  const [categoryName, setCategoryName] = useState("");
  const [newCategory, setNewCategory] = useState("");
  const [resourceQuery, setResourceQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<ResourceDraft>(emptyDraft);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const selected = categories.find((item) => item.id === categoryId);
  const filteredResources =
    selected?.resources.filter((resource) => {
      const query = resourceQuery.trim().toLocaleLowerCase("ru-RU");
      return (
        !query ||
        [resource.name, resource.domain, resource.url, resource.description]
          .join(" ")
          .toLocaleLowerCase("ru-RU")
          .includes(query)
      );
    }) || [];

  useEffect(() => {
    const controller = new AbortController();
    void archiveFetch(endpoint, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Каталог недоступен");
        const next = body.categories as Category[];
        setCategories(next);
        setCategoryId((current) => current || next[0]?.id || "");
        setCategoryName(next[0]?.name || "");
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError((reason as Error).message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, []);

  async function change(path: string, method: string, body?: unknown) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await archiveFetch(`${endpoint}${path}`, {
        method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Не удалось сохранить");
      const next = data.categories as Category[];
      setCategories(next);
      setNotice("Сохранено");
      return next;
    } catch (reason) {
      setError((reason as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  }

  function chooseCategory(category: Category) {
    setCategoryId(category.id);
    setCategoryName(category.name);
    setResourceQuery("");
    setEditing(null);
    setError("");
    setNotice("");
  }

  async function addCategory(event: FormEvent) {
    event.preventDefault();
    const next = await change("/categories", "POST", { name: newCategory });
    if (!next) return;
    const added = next.find((item) => item.name === newCategory.trim());
    if (added) chooseCategory(added);
    setNewCategory("");
  }

  async function saveCategory(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    await change(`/categories/${encodeURIComponent(selected.id)}`, "PATCH", {
      name: categoryName,
    });
  }

  function editResource(resource: Resource | null) {
    setEditing(resource?.id || "new");
    setDraft(resource || emptyDraft);
    setError("");
    setNotice("");
  }

  async function saveResource(event: FormEvent) {
    event.preventDefault();
    if (!selected || !editing) return;
    const next = await change(
      editing === "new"
        ? `/categories/${encodeURIComponent(selected.id)}/resources`
        : `/resources/${encodeURIComponent(editing)}`,
      editing === "new" ? "POST" : "PATCH",
      {
        ...draft,
        categories: draft.categories.map((tag) => tag.trim()).filter(Boolean)
          .length
          ? draft.categories.map((tag) => tag.trim()).filter(Boolean)
          : undefined,
      },
    );
    if (next) setEditing(null);
  }

  return (
    <section className="admin-card research-resources-admin">
      <div className="research-resources-heading">
        <span>
          {categories.reduce((count, item) => count + item.resources.length, 0)}{" "}
          ресурсов в каталоге
        </span>
      </div>
      {loading && <p role="status">Загружаем каталог…</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="admin-notice">
          {notice}
        </p>
      )}
      {!loading && (
        <div className="research-resources-layout">
          <div className="research-resources-categories">
            <h3>Категории</h3>
            <label
              className="research-category-mobile"
              htmlFor="research-category-select"
            >
              Категория
              <select
                id="research-category-select"
                value={categoryId}
                onChange={(event) => {
                  const category = categories.find(
                    (item) => item.id === event.target.value,
                  );
                  if (category) chooseCategory(category);
                }}
              >
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name} · {category.resources.length}
                  </option>
                ))}
              </select>
            </label>
            <nav aria-label="Категории ресурсов">
              {categories.map((category) => (
                <button
                  type="button"
                  key={category.id}
                  aria-current={category.id === categoryId ? "page" : undefined}
                  onClick={() => chooseCategory(category)}
                >
                  <span>{category.name}</span>
                  <small>{category.resources.length}</small>
                </button>
              ))}
            </nav>
            <details className="research-category-actions">
              <summary>Добавить категорию</summary>
              <form onSubmit={(event) => void addCategory(event)}>
                <label htmlFor="new-research-category">Новая категория</label>
                <div className="research-resources-add-category">
                  <input
                    id="new-research-category"
                    value={newCategory}
                    onChange={(event) => setNewCategory(event.target.value)}
                    maxLength={100}
                    required
                    disabled={busy}
                    placeholder="Например, Региональные архивы"
                  />
                  <button
                    type="submit"
                    disabled={busy || !newCategory.trim()}
                    aria-label="Добавить категорию"
                    title="Добавить категорию"
                  >
                    <Plus size={18} />
                  </button>
                </div>
              </form>
            </details>
          </div>
          <div className="research-resources-detail">
            {selected ? (
              <>
                <details className="research-category-actions research-category-edit">
                  <summary>Изменить категорию «{selected.name}»</summary>
                  <form
                    className="research-resources-category-editor"
                    onSubmit={(event) => void saveCategory(event)}
                  >
                    <label htmlFor="research-category-name">
                      Название категории
                    </label>
                    <div>
                      <input
                        id="research-category-name"
                        value={categoryName}
                        onChange={(event) =>
                          setCategoryName(event.target.value)
                        }
                        maxLength={100}
                        required
                        disabled={busy}
                      />
                      <button
                        type="submit"
                        disabled={
                          busy ||
                          !categoryName.trim() ||
                          categoryName.trim() === selected.name
                        }
                      >
                        Сохранить
                      </button>
                      <button
                        type="button"
                        className="research-resources-delete"
                        aria-label="Удалить категорию"
                        title="Удалить категорию и её ресурсы"
                        disabled={busy}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Удалить категорию «${selected.name}» и все её ресурсы (${selected.resources.length})?`,
                            )
                          )
                            return;
                          void change(
                            `/categories/${encodeURIComponent(selected.id)}`,
                            "DELETE",
                          ).then((next) => {
                            if (next) {
                              setCategoryId(next[0]?.id || "");
                              setCategoryName(next[0]?.name || "");
                              setEditing(null);
                            }
                          });
                        }}
                      >
                        <Trash2 size={17} />
                      </button>
                    </div>
                  </form>
                </details>
                <div className="research-resources-list-head">
                  <div>
                    <h3>Ресурсы · {selected.resources.length}</h3>
                    <label htmlFor="research-resource-filter">
                      <span className="research-filter-label">
                        Поиск по ресурсам
                      </span>
                      <input
                        id="research-resource-filter"
                        type="search"
                        value={resourceQuery}
                        onChange={(event) =>
                          setResourceQuery(event.target.value)
                        }
                        placeholder="Найти ресурс или домен"
                      />
                    </label>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => editResource(null)}
                  >
                    <Plus size={16} /> Добавить ресурс
                  </button>
                </div>
                {editing && (
                  <form
                    className="research-resources-editor"
                    onSubmit={(event) => void saveResource(event)}
                  >
                    <h4>
                      {editing === "new"
                        ? "Новый ресурс"
                        : "Редактировать ресурс"}
                    </h4>
                    <label>
                      Название
                      <input
                        value={draft.name}
                        onChange={(event) =>
                          setDraft({ ...draft, name: event.target.value })
                        }
                        maxLength={160}
                        required
                        disabled={busy}
                      />
                    </label>
                    <label>
                      Ссылка
                      <input
                        type="url"
                        value={draft.url}
                        onChange={(event) =>
                          setDraft({ ...draft, url: event.target.value })
                        }
                        maxLength={2048}
                        required
                        disabled={busy}
                        placeholder="https://…"
                      />
                    </label>
                    <label>
                      Описание
                      <textarea
                        value={draft.description}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            description: event.target.value,
                          })
                        }
                        maxLength={500}
                        required
                        disabled={busy}
                        rows={2}
                      />
                    </label>
                    <label>
                      <span>Разрешить веб-поиск ИИ по этому ресурсу</span>
                      <input
                        type="checkbox"
                        checked={draft.enabledForAiSearch}
                        disabled={busy}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            enabledForAiSearch: event.target.checked,
                          })
                        }
                      />
                    </label>
                    <label>
                      Домен поиска
                      <input
                        value={draft.domain}
                        placeholder="Из ссылки ресурса"
                        disabled={busy}
                        onChange={(event) =>
                          setDraft({ ...draft, domain: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      Категории веб-поиска (через запятую)
                      <input
                        value={draft.categories.join(",")}
                        placeholder="military,ww2"
                        disabled={busy}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            categories: event.target.value.split(","),
                          })
                        }
                      />
                    </label>
                    <small>
                      Например: archives, genealogy, military, ww1, ww2, books,
                      newspapers, cemeteries, repressions. Пустое поле наследует
                      категорию каталога. Отключите неиндексируемые ресурсы.
                    </small>
                    <label>
                      Приоритет поиска
                      <input
                        type="number"
                        min={-1000}
                        max={1000}
                        value={draft.priority}
                        disabled={busy}
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            priority: Number(event.target.value),
                          })
                        }
                      />
                    </label>
                    <div>
                      <button
                        type="submit"
                        className="primary-action"
                        disabled={busy}
                      >
                        Сохранить ресурс
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setEditing(null)}
                      >
                        Отмена
                      </button>
                      {editing !== "new" && (
                        <button
                          type="button"
                          className="research-resources-delete"
                          disabled={busy}
                          onClick={() => {
                            if (
                              !window.confirm(`Удалить ресурс «${draft.name}»?`)
                            )
                              return;
                            void change(
                              `/resources/${encodeURIComponent(editing)}`,
                              "DELETE",
                            ).then((next) => {
                              if (next) setEditing(null);
                            });
                          }}
                        >
                          Удалить
                        </button>
                      )}
                    </div>
                  </form>
                )}
                <div className="research-resources-list">
                  {selected.resources.length === 0 && (
                    <p>В категории пока нет ресурсов.</p>
                  )}
                  {selected.resources.length > 0 &&
                    filteredResources.length === 0 && (
                      <p>По вашему запросу ресурсов нет.</p>
                    )}
                  {filteredResources.map((resource) => (
                    <article key={resource.id}>
                      <div>
                        <strong>{resource.name}</strong>
                        <p title={resource.description}>
                          {resource.description}
                        </p>
                        <a
                          href={resource.url}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {resourceHost(resource)}{" "}
                          <ExternalLink size={13} aria-hidden="true" />
                        </a>
                      </div>
                      <span
                        className={
                          resource.enabledForAiSearch
                            ? "research-search-on"
                            : "research-search-off"
                        }
                      >
                        {resource.enabledForAiSearch
                          ? "Поиск ИИ"
                          : "Без поиска ИИ"}
                      </span>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => editResource(resource)}
                      >
                        Изменить
                      </button>
                    </article>
                  ))}
                </div>
              </>
            ) : (
              <p>Добавьте категорию, чтобы разместить в ней ресурсы.</p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
