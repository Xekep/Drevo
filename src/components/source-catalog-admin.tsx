import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import type { Family } from "../domain";
import type { CatalogSource } from "../shared/source-catalog.ts";
import { PersonSearch } from "./person-search.tsx";
import {
  confirmDiscardChanges,
  useUnsavedChanges,
} from "../hooks/useUnsavedChanges";
import "../styles/source-catalog-admin.css";

type SavedSource = CatalogSource & { version: number };
type Page = { sources: SavedSource[]; total: number };
type DocumentOption = { id: string; title: string };
const PAGE_SIZE = 20;
const empty: Omit<CatalogSource, "id"> = {
  title: "",
  type: "",
  author: "",
  institution: "",
  archive: "",
  fond: "",
  opis: "",
  delo: "",
  sheet: "",
  reference: "",
  url: "",
  accessedAt: "",
  description: "",
  documentIds: [],
};

async function api(path: string, init?: RequestInit) {
  const response = await archiveFetch(path, init);
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error || "Не удалось выполнить запрос");
  return data;
}

function DocumentPicker({
  ids,
  onChange,
  disabled,
  titles,
  onDocuments,
}: {
  ids: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
  titles: Record<string, string>;
  onDocuments: (items: DocumentOption[]) => void;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<DocumentOption[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [offset, setOffset] = useState(0);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await api(
          `/api/documents?q=${encodeURIComponent(query.trim())}&limit=10&offset=${offset}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        const next = data.items as DocumentOption[];
        setItems((current) => (offset ? [...current, ...next] : next));
        setTotal(data.total);
        onDocuments(next);
      } catch (reason) {
        if (!controller.signal.aborted) setError((reason as Error).message);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, offset, retry, onDocuments]);

  return (
    <div className="source-documents">
      <label>
        Найти документ в архиве
        <input
          value={query}
          maxLength={100}
          disabled={disabled}
          placeholder="Название документа"
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
            setItems([]);
          }}
        />
      </label>
      {ids.length > 0 && (
        <div
          className="source-document-tags"
          aria-label="Прикреплённые документы"
        >
          {ids.map((id) => (
            <span key={id}>
              {titles[id] || "Загружаем название…"}
              <button
                type="button"
                disabled={disabled}
                aria-label={`Убрать документ ${titles[id] || "из источника"}`}
                onClick={() => onChange(ids.filter((item) => item !== id))}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      {loading && <small role="status">Ищем документы…</small>}
      {error && (
        <p role="alert" className="form-error">
          {error}{" "}
          <button type="button" onClick={() => setRetry((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}
      {!error && (
        <div className="source-document-results">
          {items
            .filter((item) => !ids.includes(item.id))
            .map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={disabled || ids.length >= 100}
                onClick={() => onChange([...ids, item.id])}
              >
                {item.title}
              </button>
            ))}
          {!loading && !items.length && <small>Документы не найдены</small>}
          {items.length < total && (
            <button
              type="button"
              disabled={loading}
              onClick={() => setOffset(items.length)}
            >
              Показать ещё
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function SourceCatalogAdmin({
  family,
  onChanged,
  onDirtyChange,
}: {
  family: Family;
  onChanged: () => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [offset, setOffset] = useState(0);
  const [reload, setReload] = useState(0);
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [listError, setListError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<SavedSource | "new" | null>(null);
  const [draft, setDraft] = useState<Omit<CatalogSource, "id">>(empty);
  const [initialDraft, setInitialDraft] = useState(JSON.stringify(empty));
  const dirty = editing !== null && JSON.stringify(draft) !== initialDraft;
  useUnsavedChanges(dirty, onDirtyChange);
  const [personId, setPersonId] = useState("");
  const [eventId, setEventId] = useState("");
  const [linkDocumentId, setLinkDocumentId] = useState("");
  const [documentPage, setDocumentPage] = useState("");
  const [documentTitles, setDocumentTitles] = useState<Record<string, string>>(
    {},
  );
  const titleCache = useRef<Record<string, string>>({});
  const rememberDocuments = useCallback((items: DocumentOption[]) => {
    for (const item of items) titleCache.current[item.id] = item.title;
    setDocumentTitles({ ...titleCache.current });
  }, []);
  const linkedDocumentKey = JSON.stringify([
    ...new Set([
      ...draft.documentIds,
      ...(editing && editing !== "new" ? editing.documentIds : []),
    ]),
  ]);
  useEffect(() => {
    const controller = new AbortController();
    const missing = (JSON.parse(linkedDocumentKey) as string[]).filter(
      (id) => !titleCache.current[id],
    );
    void (async () => {
      // Existing links may be outside the current search page. Bound requests
      // instead of fetching the entire documents catalogue.
      for (let offset = 0; offset < missing.length; offset += 5) {
        const items = await Promise.all(
          missing.slice(offset, offset + 5).map(async (id) => {
            try {
              const item = await api(
                `/api/documents/${encodeURIComponent(id)}`,
                { signal: controller.signal },
              );
              return { id, title: item.title || "Документ без названия" };
            } catch {
              return { id, title: "Документ недоступен" };
            }
          }),
        );
        if (controller.signal.aborted) return;
        rememberDocuments(items);
      }
    })();
    return () => controller.abort();
  }, [linkedDocumentKey, rememberDocuments]);
  const person = family.people.find((item) => item.id === personId);
  const citations = eventId
    ? person?.events?.find((item) => item.id === eventId)?.sources || []
    : person?.sources || [];

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const data = await api(
          `/api/sources?q=${encodeURIComponent(query.trim())}&limit=${PAGE_SIZE}&offset=${offset}`,
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) {
          setPage(data as Page);
          setListError("");
        }
      } catch (reason) {
        if (!controller.signal.aborted) {
          setListError((reason as Error).message);
          setPage(null);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, offset, reload]);

  function choose(source: SavedSource | "new", saved = false) {
    if (busy && !saved) return;
    if (!saved && !confirmDiscardChanges(dirty)) return;
    setEditing(source);
    if (source === "new") {
      setDraft({ ...empty, documentIds: [] });
      setInitialDraft(JSON.stringify(empty));
    } else {
      const fields = { ...source, documentIds: [...source.documentIds] };
      delete (fields as Partial<SavedSource>).id;
      delete (fields as Partial<SavedSource>).version;
      setDraft(fields);
      setInitialDraft(JSON.stringify(fields));
    }
    setLinkDocumentId(source === "new" ? "" : source.documentIds[0] || "");
    setDocumentPage("");
    setError("");
    setNotice("");
  }
  function field(
    key: keyof Omit<CatalogSource, "id" | "documentIds">,
    label: string,
    multiline = false,
  ) {
    return (
      <label key={key}>
        {label}
        {multiline ? (
          <textarea
            value={draft[key]}
            maxLength={10_000}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        ) : (
          <input
            value={draft[key]}
            maxLength={2_000}
            disabled={busy}
            type={
              key === "accessedAt" ? "date" : key === "url" ? "url" : "text"
            }
            required={key === "title"}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        )}
      </label>
    );
  }
  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await api(
        editing === "new" ? "/api/sources" : `/api/sources/${editing.id}`,
        {
          method: editing === "new" ? "POST" : "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...draft,
            ...(editing === "new" ? {} : { version: editing.version }),
          }),
        },
      );
      choose(data.source as SavedSource, true);
      setNotice("Источник сохранён");
      setOffset(0);
      setReload((n) => n + 1);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (
      !editing ||
      editing === "new" ||
      !window.confirm("Удалить источник из каталога?")
    )
      return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/sources/${editing.id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: editing.version }),
      });
      setEditing(null);
      setNotice("Источник удалён");
      setOffset(0);
      setReload((n) => n + 1);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function link(method: "POST" | "DELETE") {
    if (!editing || editing === "new" || !personId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt) {
          const current = await api(`/api/sources/${editing.id}`);
          if (current.source.version !== editing.version)
            throw new Error(
              "Источник изменён в другой вкладке. Обновите запись перед привязкой.",
            );
        }
        const snapshot = await api("/api/family?projection=overview");
        try {
          await api(`/api/sources/${editing.id}/links`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              personId,
              ...(eventId ? { eventId } : {}),
              revision: snapshot.revision,
              ...(method === "POST" && linkDocumentId
                ? { documentId: linkDocumentId }
                : {}),
              ...(method === "POST" && documentPage
                ? { documentPage: Number(documentPage) }
                : {}),
            }),
          });
          break;
        } catch (reason) {
          if (
            attempt ||
            method !== "POST" ||
            !(reason as Error).message.includes("Архив изменён")
          )
            throw reason;
        }
      }
      onChanged();
      setNotice(
        method === "POST"
          ? "Источник привязан к факту"
          : "Связь с фактом удалена",
      );
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-card source-catalog-admin">
      <div className="source-catalog-toolbar">
        <label>
          Поиск по названию, архиву и шифру
          <input
            value={query}
            maxLength={100}
            placeholder="Найти источник"
            onChange={(event) => {
              setQuery(event.target.value);
              setOffset(0);
            }}
          />
        </label>
        <button
          type="button"
          className="primary-action"
          onClick={() => choose("new")}
        >
          Добавить источник
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {listError && (
        <p className="form-error" role="alert">
          {listError}{" "}
          <button type="button" onClick={() => setReload((n) => n + 1)}>
            Повторить
          </button>
        </p>
      )}
      {notice && (
        <p className="admin-notice" role="status">
          {notice}
        </p>
      )}
      <div className="source-catalog-layout">
        <div className="source-catalog-list" aria-label="Каталог источников">
          {loading && <p role="status">Загружаем источники…</p>}
          {!loading && page?.sources.length === 0 && (
            <p>Источники не найдены.</p>
          )}
          {page?.sources.map((source) => (
            <button
              type="button"
              key={source.id}
              aria-current={
                editing !== "new" && editing?.id === source.id
                  ? "true"
                  : undefined
              }
              onClick={() => choose(source)}
            >
              <strong>{source.title}</strong>
              <small>
                {[source.archive, source.reference]
                  .filter(Boolean)
                  .join(" · ") || source.type}
              </small>
            </button>
          ))}
          {page && (
            <div className="source-catalog-pages">
              <span>
                {page.total
                  ? `${offset + 1}–${offset + page.sources.length} из ${page.total}`
                  : "0 источников"}
              </span>
              <button
                type="button"
                disabled={offset === 0 || loading}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                Назад
              </button>
              <button
                type="button"
                disabled={offset + PAGE_SIZE >= page.total || loading}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Дальше
              </button>
            </div>
          )}
        </div>
        {editing && (
          <div className="source-catalog-editor">
            <form
              className="archive-form"
              onSubmit={(event) => void save(event)}
            >
              <h2>
                {editing === "new"
                  ? "Новый источник"
                  : "Редактировать источник"}
              </h2>
              {field("title", "Название")}
              <div className="source-catalog-fields">
                {field("type", "Тип")}
                {field("archive", "Архив")}
              </div>
              <div className="source-catalog-fields">
                {field("fond", "Фонд")}
                {field("opis", "Опись")}
                {field("delo", "Дело")}
                {field("sheet", "Лист")}
              </div>
              <details>
                <summary>Другие реквизиты</summary>
                <div className="source-catalog-extra">
                  {field("author", "Автор")}
                  {field("institution", "Учреждение")}
                  {field("reference", "Архивный шифр")}
                  {field("url", "Ссылка")}
                  {field("accessedAt", "Дата обращения")}
                  {field("description", "Описание", true)}
                </div>
              </details>
              <DocumentPicker
                ids={draft.documentIds}
                disabled={busy}
                titles={documentTitles}
                onDocuments={rememberDocuments}
                onChange={(documentIds) => setDraft({ ...draft, documentIds })}
              />
              <footer>
                <button
                  type="submit"
                  className="primary-action"
                  disabled={busy || !draft.title.trim()}
                >
                  {busy ? "Сохраняем…" : "Сохранить"}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    if (confirmDiscardChanges(dirty)) setEditing(null);
                  }}
                >
                  Закрыть
                </button>
                {editing !== "new" && (
                  <button
                    type="button"
                    disabled={busy}
                    className="danger-action"
                    onClick={() => void remove()}
                  >
                    Удалить
                  </button>
                )}
              </footer>
            </form>
            {editing !== "new" && (
              <div className="source-catalog-link">
                <h3>Привязать к факту</h3>
                <PersonSearch
                  value={personId}
                  selected={person}
                  onChange={(id) => {
                    setPersonId(id);
                    setEventId("");
                  }}
                  label="Человек"
                />
                {person && (
                  <label>
                    Факт
                    <select
                      value={eventId}
                      onChange={(event) => setEventId(event.target.value)}
                    >
                      <option value="">Карточка человека</option>
                      {(person.events || []).map((event) => (
                        <option key={event.id} value={event.id}>
                          {event.title || event.type} {event.date || ""}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {person && (
                  <>
                    {editing.documentIds.length > 0 && (
                      <label>
                        Документ источника
                        <select
                          value={linkDocumentId}
                          onChange={(event) => {
                            setLinkDocumentId(event.target.value);
                            setDocumentPage("");
                          }}
                        >
                          {editing.documentIds.map((id) => (
                            <option key={id} value={id}>
                              {documentTitles[id] || "Загружаем название…"}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                    {linkDocumentId && (
                      <label>
                        Страница документа
                        <input
                          type="number"
                          min={1}
                          max={2000}
                          value={documentPage}
                          onChange={(event) =>
                            setDocumentPage(event.target.value)
                          }
                        />
                      </label>
                    )}
                    <div className="source-catalog-link-actions">
                      <button
                        type="button"
                        disabled={
                          busy ||
                          citations.some(
                            (item) => item.catalogId === editing.id,
                          )
                        }
                        onClick={() => void link("POST")}
                      >
                        Привязать
                      </button>
                      {citations.some(
                        (item) => item.catalogId === editing.id,
                      ) && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => void link("DELETE")}
                        >
                          Убрать связь
                        </button>
                      )}
                    </div>
                    {citations.some(
                      (item) => item.catalogId === editing.id,
                    ) && <small>Источник уже подтверждает этот факт.</small>}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
