import { useCallback, useEffect, useRef, useState } from "react";
import { archiveFetch } from "../data/archive-fetch.ts";
import { scopedArchivePath } from "../domain/archive-context.ts";
import { archiveDocumentPath } from "../domain/archive-routes.ts";

export type DocumentOption = { id: string; title: string };
type Page = {
  personId: string;
  query: string;
  items: DocumentOption[];
  total: number;
};
const PAGE_SIZE = 20;

/** Chooses an existing document linked to this person; no file is copied. */
export function DocumentSourcePicker({
  personId,
  documentId,
  pageNumber,
  onChange,
  onPageChange,
}: {
  personId?: string;
  documentId?: string;
  pageNumber?: number;
  onChange: (document: DocumentOption | undefined) => void;
  onPageChange: (page: number | undefined) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState<Page | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const request = useRef<AbortController | null>(null);
  const search = query.trim();

  const load = useCallback(
    async (offset: number, term: string) => {
      if (!personId) return;
      request.current?.abort();
      const controller = new AbortController();
      request.current = controller;
      setLoading(true);
      setError(false);
      try {
        const url = `/api/documents?personId=${encodeURIComponent(personId)}&q=${encodeURIComponent(term)}&limit=${PAGE_SIZE}&offset=${offset}`;
        const response = await archiveFetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error("Document list failed");
        const result = (await response.json()) as {
          items: DocumentOption[];
          total: number;
        };
        if (!controller.signal.aborted)
          setPage((current) => ({
            personId,
            query: term,
            items:
              offset && current?.personId === personId && current.query === term
                ? [...current.items, ...result.items]
                : result.items,
            total: result.total,
          }));
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [personId],
  );

  useEffect(() => {
    if (!open || !personId) return;
    const timer = window.setTimeout(() => void load(0, search), 180);
    return () => {
      window.clearTimeout(timer);
      request.current?.abort();
    };
  }, [open, personId, search, load]);

  const visible =
    page && page.personId === personId && page.query === search ? page : null;
  return (
    <div className="document-source-picker">
      {documentId && (
        <span>
          <a
            href={scopedArchivePath(archiveDocumentPath(null, documentId, pageNumber))}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть связанный документ
          </a>{" "}
          <button type="button" onClick={() => onChange(undefined)}>
            Убрать связь с документом
          </button>
        </span>
      )}
      {documentId && (
        <label className="document-source-page">
          Страница документа
          <input
            type="number"
            min={1}
            max={2000}
            value={pageNumber ?? ""}
            placeholder="Не указана"
            onChange={(event) => {
              const page = Number(event.target.value);
              onPageChange(
                event.target.value && Number.isInteger(page) && page >= 1 && page <= 2000
                  ? page
                  : undefined,
              );
            }}
          />
        </label>
      )}
      <button
        type="button"
        disabled={!personId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open
          ? "Закрыть выбор документа"
          : documentId
            ? "Другой документ"
            : "Связать с документом"}
      </button>
      {!personId && <small>Сначала сохраните карточку человека.</small>}
      {open && personId && (
        <div className="document-source-picker-list">
          <label>
            Найти документ человека
            <input
              value={query}
              maxLength={100}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          {visible?.items.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={documentId === item.id}
              onClick={() => {
                onChange(item);
                setOpen(false);
              }}
            >
              {item.title}
            </button>
          ))}
          {loading && <small role="status">Загружаем документы…</small>}
          {error && (
            <small role="alert">
              Не удалось загрузить документы. Повторите поиск.
            </small>
          )}
          {!loading && !error && visible && !visible.items.length && (
            <small>
              Документ не найден. Сначала привяжите его к человеку в разделе
              «Документы».
            </small>
          )}
          {visible && visible.items.length < visible.total && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void load(visible.items.length, search)}
            >
              Показать ещё
            </button>
          )}
        </div>
      )}
    </div>
  );
}
