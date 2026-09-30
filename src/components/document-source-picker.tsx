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

/** Chooses an existing PDF linked to this person; no file or person link is copied. */
export function DocumentSourcePicker({
  personId,
  documentId,
  onChange,
}: {
  personId?: string;
  documentId?: string;
  onChange: (document: DocumentOption | undefined) => void;
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
            href={scopedArchivePath(archiveDocumentPath(null, documentId))}
            target="_blank"
            rel="noopener noreferrer"
          >
            Открыть связанный PDF
          </a>{" "}
          <button type="button" onClick={() => onChange(undefined)}>
            Убрать связь с PDF
          </button>
        </span>
      )}
      <button
        type="button"
        disabled={!personId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {open
          ? "Закрыть выбор PDF"
          : documentId
            ? "Другой PDF"
            : "Связать с PDF"}
      </button>
      {!personId && <small>Сначала сохраните карточку человека.</small>}
      {open && personId && (
        <div className="document-source-picker-list">
          <label>
            Найти PDF человека
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
          {loading && <small role="status">Загружаем PDF…</small>}
          {error && (
            <small role="alert">
              Не удалось загрузить PDF. Повторите поиск.
            </small>
          )}
          {!loading && !error && visible && !visible.items.length && (
            <small>
              PDF не найден. Сначала привяжите его к человеку в разделе
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
