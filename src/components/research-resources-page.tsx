import { useEffect, useMemo, useState } from "react";
import { ExternalLink, Search, X } from "lucide-react";
import type { ResearchDirectoryCategory } from "../shared/research-catalog";
import { safeUrl } from "../domain";
import { fetchWithTimeout } from "../data/request-timeout";
import { archiveFetch } from "../data/archive-fetch";
import "../styles/research-resources-page.css";

const normalize = (text: string) =>
  text.toLocaleLowerCase("ru-RU").replaceAll("ё", "е");

export default function ResearchResourcesPage() {
  const [categories, setCategories] = useState<ResearchDirectoryCategory[]>([]);
  const [query, setQuery] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void fetchWithTimeout(
      "/api/research-resources",
      {
        signal: controller.signal,
        cache: "no-store",
      },
      undefined,
      archiveFetch,
    )
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.categories))
          throw new Error("Каталог недоступен");
        if (!controller.signal.aborted) setCategories(data.categories);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError("Не удалось загрузить справочник. Попробуйте ещё раз.");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [attempt]);

  const visible = useMemo(() => {
    const words = normalize(query).trim().split(/\s+/).filter(Boolean);
    return categories
      .filter((category) => !categoryId || category.id === categoryId)
      .map((category) => ({
        ...category,
        resources: category.resources.filter((resource) => {
          const text = normalize(
            `${category.name} ${resource.name} ${resource.description} ${resource.url}`,
          );
          return words.every((word) => text.includes(word));
        }),
      }))
      .filter((category) => category.resources.length);
  }, [categories, categoryId, query]);
  const total = categories.reduce(
    (sum, category) => sum + category.resources.length,
    0,
  );
  const count = visible.reduce(
    (sum, category) => sum + category.resources.length,
    0,
  );

  return (
    <section className="research-directory">
      <header className="research-directory-heading">
        <span>Справочник</span>
        <h1>Ресурсы поиска</h1>
        <p>
          Архивы, базы и библиотеки для исследования истории семьи. Из этого же
          каталога ИИ-ассистент выбирает источники для поиска.
        </p>
      </header>
      {loading ? (
        <p role="status">Загружаем справочник…</p>
      ) : error ? (
        <div className="research-directory-empty">
          <p role="alert">{error}</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              setError("");
              setAttempt((value) => value + 1);
            }}
          >
            Повторить
          </button>
        </div>
      ) : !total ? (
        <div className="research-directory-empty">
          <h2>Ресурсы пока не добавлены</h2>
          <p>Когда администратор добавит сайты, они появятся здесь.</p>
        </div>
      ) : (
        <>
          <div className="research-directory-filters">
            <div className="research-directory-search">
              <Search size={18} aria-hidden="true" />
              <input
                type="search"
                aria-label="Найти ресурс"
                placeholder="Название, тема или сайт"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.stopPropagation();
                    setQuery("");
                  }
                }}
              />
              {query && (
                <button
                  type="button"
                  aria-label="Очистить поиск ресурсов"
                  onClick={() => setQuery("")}
                >
                  <X size={17} />
                </button>
              )}
            </div>
            <label>
              <span>Категория</span>
              <select
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                <option value="">Все категории</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="research-directory-count" role="status">
            Показано: {count} из {total}
          </p>
          {!count && (
            <div className="research-directory-empty">
              <h2>Ничего не найдено</h2>
              <p>Попробуйте другую тему или выберите все категории.</p>
            </div>
          )}
          {visible.map((category) => (
            <section
              className="research-directory-group"
              key={category.id}
              aria-label={category.name}
            >
              <h2>
                {category.name} <span>{category.resources.length}</span>
              </h2>
              <ul>
                {category.resources.map((resource) => {
                  const href = /^https?:\/\//i.test(resource.url)
                    ? safeUrl(resource.url)
                    : undefined;
                  return (
                    <li key={resource.id}>
                      <h3>
                        {href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            {resource.name}
                            <ExternalLink size={16} aria-hidden="true" />
                          </a>
                        ) : (
                          resource.name
                        )}
                      </h3>
                      <p>{resource.description}</p>
                      {href && (
                        <small>
                          {new URL(href).hostname.replace(/^www\./, "")}
                        </small>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </>
      )}
    </section>
  );
}
