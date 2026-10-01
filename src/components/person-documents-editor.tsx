import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpenText, Link2, Unlink } from "lucide-react";
import { archiveFetch } from "../data/archive-fetch";
import { scopedArchivePath } from "../domain/archive-context";
import { archiveDocumentPath } from "../domain/archive-routes";
import type { ListedDocument } from "./documents-catalog";
import "../styles/documents.css";

export function PersonDocumentsEditor({
  personId,
  disabled,
}: {
  personId?: string;
  disabled: boolean;
}) {
  const [linked, setLinked] = useState<ListedDocument[]>([]);
  const [items, setItems] = useState<ListedDocument[]>([]);
  const [total, setTotal] = useState(0);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const pageRequest = useRef<AbortController | null>(null);
  const load = useCallback(
    async (offset: number) => {
      pageRequest.current?.abort();
      const request = new AbortController();
      pageRequest.current = request;
      const { signal } = request;
      setLoading(true);
      try {
        const response = await archiveFetch(
          `/api/documents?limit=30&offset=${offset}&q=${encodeURIComponent(query.trim())}`,
          { signal },
        );
        if (!response.ok)
          throw new Error("Не удалось загрузить каталог документов");
        const data = (await response.json()) as {
          items: ListedDocument[];
          total: number;
        };
        if (!signal.aborted) {
          setItems((current) =>
            offset ? [...current, ...data.items] : data.items,
          );
          setTotal(data.total);
        }
      } catch (reason) {
        if (!signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить каталог",
          );
      } finally {
        if (!signal.aborted) setLoading(false);
      }
    },
    [query],
  );
  useEffect(() => {
    if (!personId) return;
    const request = new AbortController();
    void (async () => {
      try {
        // A person can have more than one catalogue page of documents.
        const all: ListedDocument[] = [];
        let count = Infinity;
        while (all.length < count) {
          const response = await archiveFetch(
            `/api/documents?personId=${encodeURIComponent(personId)}&limit=100&offset=${all.length}`,
            { signal: request.signal },
          );
          if (!response.ok)
            throw new Error("Не удалось загрузить документы человека");
          const data = (await response.json()) as {
            items: ListedDocument[];
            total: number;
          };
          all.push(...data.items);
          count = data.total;
          if (!data.items.length) break;
        }
        if (!request.signal.aborted) setLinked(all);
      } catch (reason) {
        if (!request.signal.aborted)
          setError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить документы",
          );
      }
    })();
    return () => request.abort();
  }, [personId, revision]);
  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(() => void load(0), 180);
    return () => {
      window.clearTimeout(timer);
      pageRequest.current?.abort();
    };
  }, [open, load, revision]);

  async function change(entry: ListedDocument, attach: boolean) {
    if (!personId || busy || disabled) return;
    setBusy(true);
    setError("");
    try {
      const ids = entry.people.map((person) => person.id);
      const response = await archiveFetch(`/api/documents/${entry.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          people: {
            expected: ids,
            next: attach
              ? [...new Set([...ids, personId])]
              : ids.filter((id) => id !== personId),
          },
        }),
      });
      const data = (await response.json()) as ListedDocument & {
        error?: string;
      };
      if (!response.ok)
        throw new Error(data.error || "Не удалось изменить привязку");
      setLinked((current) =>
        attach
          ? [...current.filter((item) => item.id !== entry.id), data]
          : current.filter((item) => item.id !== entry.id),
      );
      setItems((current) =>
        current.map((item) => (item.id === data.id ? data : item)),
      );
      setRevision((value) => value + 1);
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Не удалось изменить привязку",
      );
      setRevision((value) => value + 1);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="person-documents-editor"
      aria-label="Документы человека"
    >
      <h3>
        <BookOpenText size={17} aria-hidden="true" /> Документы
      </h3>
      {!personId ? (
        <p className="field-hint">
          Сохраните нового человека, чтобы привязать к нему документ из каталога.
        </p>
      ) : (
        <>
          <p className="field-hint">
            Файлы из раздела «Документы». Кнопки «Привязать» и «Отвязать»
            сохраняют привязку сразу.
          </p>
          {!linked.length && (
            <p className="field-hint">Нет привязанных документов.</p>
          )}
          {linked.map((entry) => (
            <div className="person-document-row" key={entry.id}>
              <a
                href={scopedArchivePath(archiveDocumentPath(null, entry.id))}
                target="_blank"
                rel="noreferrer"
              >
                {entry.title}
              </a>
              {entry.canDelete && (
                <button
                  type="button"
                  disabled={disabled || busy}
                  onClick={() => void change(entry, false)}
                  aria-label={`Отвязать ${entry.title}`}
                >
                  <Unlink size={14} /> Отвязать
                </button>
              )}
            </div>
          ))}
          <button
            type="button"
            disabled={disabled || busy}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <Link2 size={15} />{" "}
            {open ? "Закрыть выбор документов" : "Привязать документ из каталога"}
          </button>
          {open && (
            <div className="person-document-picker">
              <label>
                Найти документ
                <input
                  value={query}
                  maxLength={100}
                  placeholder="Название или сведения о документе"
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <p className="field-hint">
                Привязывать можно свои документы. Администратору доступны все.
              </p>
              {items
                .filter(
                  (entry) =>
                    entry.canDelete &&
                    !linked.some((item) => item.id === entry.id),
                )
                .map((entry) => (
                  <div className="person-document-row" key={entry.id}>
                    <span>{entry.title}</span>
                    <button
                      type="button"
                      disabled={disabled || busy}
                      onClick={() => void change(entry, true)}
                    >
                      Привязать
                    </button>
                  </div>
                ))}
              {loading && <p role="status">Загружаем…</p>}
              {!loading &&
                !items.some(
                  (entry) =>
                    entry.canDelete &&
                    !linked.some((item) => item.id === entry.id),
                ) && (
                  <p className="field-hint">
                    На этой странице нет документов для привязки.
                  </p>
                )}
              {items.length < total && (
                <button
                  type="button"
                  disabled={loading || busy}
                  onClick={() => void load(items.length)}
                >
                  Показать ещё
                </button>
              )}
            </div>
          )}
        </>
      )}
      {error && (
        <p className="documents-upload-error" role="alert">
          {error}{" "}
          <button
            type="button"
            onClick={() => {
              setError("");
              setRevision((value) => value + 1);
            }}
          >
            Повторить загрузку
          </button>
        </p>
      )}
    </section>
  );
}
