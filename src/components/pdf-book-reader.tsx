import {
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  Download,
  List,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { LensZoom } from "@jojovms/lens-zoom-core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ListedDocument } from "./documents-catalog";
import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import type {
  AnnotationSelection,
  DocumentAnnotation,
} from "../shared/document-annotations";

type OutlineEntry = { title: string; page: number; depth: number };
type Point = { x: number; y: number };

function position(event: ReactPointerEvent<HTMLElement>): Point {
  const bounds = event.currentTarget.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
    y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
  };
}

function rectangle(start: Point, end: Point) {
  return {
    x: Math.min(start.x, end.x),
    y: Math.min(start.y, end.y),
    width: Math.abs(start.x - end.x),
    height: Math.abs(start.y - end.y),
  };
}

function pageBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Не удалось подготовить страницу")),
      "image/webp",
      0.92,
    ),
  );
}

export function PdfBookReader({
  document: entry,
  initialPage = 1,
  onClose,
  onEdit,
  mayAnnotate = false,
  annotateOnOpen = false,
}: {
  document: ListedDocument;
  initialPage?: number;
  onClose: () => void;
  onEdit?: () => void;
  mayAnnotate?: boolean;
  annotateOnOpen?: boolean;
}) {
  const closeButton = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  const closeLatest = useRef(onClose);
  const magnifierLatest = useRef(false);
  const renderNearby = useRef<((index: number) => void) | null>(null);
  const dragStart = useRef<Point | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(Math.max(0, initialPage - 1));
  const [pageUrls, setPageUrls] = useState<Record<number, string>>({});
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [magnifier, setMagnifier] = useState(false);
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([]);
  const [annotationError, setAnnotationError] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(annotateOnOpen);
  const [annotating, setAnnotating] = useState(annotateOnOpen);
  const [selection, setSelection] = useState<AnnotationSelection | null>(null);
  const [draft, setDraft] = useState<ReturnType<typeof rectangle> | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeAnnotation, setActiveAnnotation] = useState("");

  useEffect(() => {
    closeLatest.current = onClose;
  }, [onClose]);
  useEffect(() => {
    magnifierLatest.current = magnifier;
  }, [magnifier]);

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeButton.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (magnifierLatest.current) {
          event.preventDefault();
          magnifierLatest.current = false;
          setMagnifier(false);
        } else closeLatest.current();
      } else if (
        event.key === "ArrowRight" &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        setPageIndex((index) => Math.min(pageCount - 1, index + 1));
      } else if (
        event.key === "ArrowLeft" &&
        !(event.target instanceof HTMLTextAreaElement)
      ) {
        setPageIndex((index) => Math.max(0, index - 1));
      } else if (event.key === "Tab") {
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), textarea:not([disabled])",
          ) || []),
        ].filter((element) => element.getClientRects().length > 0);
        const first = controls[0],
          last = controls.at(-1);
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [pageCount]);

  useEffect(() => {
    let active = true;
    let pdf: PDFDocumentProxy | null = null;
    let loadingTask: ReturnType<
      (typeof import("pdfjs-dist"))["getDocument"]
    > | null = null;
    const urls = new Map<number, string>();
    const pending = new Map<number, Promise<void>>();
    let currentPage = 0;
    const render = (index: number): Promise<void> => {
      if (!pdf || index < 0 || index >= pdf.numPages || urls.has(index))
        return Promise.resolve();
      const existing = pending.get(index);
      if (existing) return existing;
      const task = (async () => {
        const page = await pdf!.getPage(index + 1);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(2.5, 2200 / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Не удалось отобразить PDF");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const blob = await pageBlob(canvas);
        page.cleanup();
        if (!active) return;
        const url = URL.createObjectURL(blob);
        if (Math.abs(index - currentPage) > 3) {
          URL.revokeObjectURL(url);
          return;
        }
        urls.set(index, url);
        setPageUrls((current) => ({ ...current, [index]: url }));
      })().finally(() => pending.delete(index));
      pending.set(index, task);
      return task;
    };
    renderNearby.current = (index) => {
      currentPage = index;
      const removed: number[] = [];
      for (const [page, url] of urls) {
        if (Math.abs(page - index) <= 3) continue;
        URL.revokeObjectURL(url);
        urls.delete(page);
        removed.push(page);
      }
      if (removed.length)
        setPageUrls((current) => {
          const next = { ...current };
          for (const page of removed) delete next[page];
          return next;
        });
      for (
        let page = Math.max(0, index - 1);
        page <= Math.min(index + 2, (pdf?.numPages || 0) - 1);
        page++
      )
        void render(page).catch(() => {
          if (active) setError("Не удалось загрузить страницу PDF");
        });
    };
    void (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({
          url: archiveResourceUrl(entry.url),
          withCredentials: entry.url.startsWith("/"),
        });
        pdf = await loadingTask.promise;
        if (!active) return;
        if (pdf.numPages < 1 || pdf.numPages > 2000)
          throw new Error("Документ должен содержать от 1 до 2000 страниц");
        const firstPage = Math.min(pdf.numPages - 1, Math.max(0, initialPage - 1));
        setPageCount(pdf.numPages);
        setPageIndex(firstPage);
        void (async () => {
          try {
            const bookmarks = await pdf!.getOutline();
            if (!bookmarks?.length) return;
            const entries: OutlineEntry[] = [];
            const collect = async (items: typeof bookmarks, depth: number) => {
              for (const item of items) {
                const destination =
                  typeof item.dest === "string"
                    ? await pdf!.getDestination(item.dest)
                    : item.dest;
                if (destination?.length) {
                  const target = destination[0];
                  const page =
                    typeof target === "number"
                      ? target
                      : await pdf!.getPageIndex(target);
                  if (page >= 0 && page < pdf!.numPages)
                    entries.push({ title: item.title, page, depth });
                }
                if (item.items?.length) await collect(item.items, depth + 1);
              }
            };
            await collect(bookmarks, 0);
            if (active) setOutline(entries);
          } catch {
            // A damaged bookmark tree should not prevent reading valid pages.
          }
        })();
        await render(firstPage);
        if (!active) return;
        setLoading(false);
        renderNearby.current?.(firstPage);
      } catch (reason) {
        if (active) {
          setError(
            reason instanceof Error ? reason.message : "Не удалось открыть PDF",
          );
          setLoading(false);
        }
      }
    })();
    return () => {
      active = false;
      renderNearby.current = null;
      void loadingTask?.destroy();
      for (const url of urls.values()) URL.revokeObjectURL(url);
    };
  }, [entry.url, initialPage]);

  useEffect(() => {
    renderNearby.current?.(pageIndex);
  }, [pageIndex]);
  useEffect(() => {
    if (!magnifier || !pageUrls[pageIndex] || !sheet.current) return;
    const lens = new LensZoom(sheet.current, {
      zoom: 2.5,
      lensSize: 180,
      lensColor: "#fff",
      borderColor: "#818981",
    });
    lens.init();
    return () => lens.cleanup();
  }, [magnifier, pageIndex, pageUrls]);
  useEffect(() => {
    const request = new AbortController();
    void (async () => {
      try {
        const response = await archiveFetch(
          `/api/documents/${entry.id}/annotations`,
          {
            signal: request.signal,
          },
        );
        if (!response.ok) throw new Error("Не удалось загрузить комментарии");
        const result = (await response.json()) as {
          items: DocumentAnnotation[];
        };
        if (!request.signal.aborted) setAnnotations(result.items);
      } catch (reason) {
        if (!request.signal.aborted)
          setAnnotationError(
            reason instanceof Error
              ? reason.message
              : "Не удалось загрузить комментарии",
          );
      }
    })();
    return () => request.abort();
  }, [entry.id]);

  const saveAnnotation = async () => {
    if (!selection || !comment.trim() || saving) return;
    setSaving(true);
    setAnnotationError("");
    try {
      const response = await archiveFetch(
        `/api/documents/${entry.id}/annotations`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...selection, text: comment.trim() }),
        },
      );
      const result = (await response.json()) as {
        items?: DocumentAnnotation[];
        error?: string;
      };
      if (!response.ok || !result.items)
        throw new Error(result.error || "Не удалось сохранить комментарий");
      setAnnotations(result.items);
      setActiveAnnotation(result.items.at(-1)?.id || "");
      setSelection(null);
      setComment("");
      setAnnotating(false);
    } catch (reason) {
      setAnnotationError(
        reason instanceof Error
          ? reason.message
          : "Не удалось сохранить комментарий",
      );
    } finally {
      setSaving(false);
    }
  };

  const removeAnnotation = async (id: string) => {
    setAnnotationError("");
    try {
      const response = await archiveFetch(
        `/api/documents/${entry.id}/annotations/${id}`,
        { method: "DELETE" },
      );
      const result = (await response.json()) as {
        items?: DocumentAnnotation[];
        error?: string;
      };
      if (!response.ok || !result.items)
        throw new Error(result.error || "Не удалось удалить комментарий");
      setAnnotations(result.items);
      if (activeAnnotation === id) setActiveAnnotation("");
    } catch (reason) {
      setAnnotationError(
        reason instanceof Error
          ? reason.message
          : "Не удалось удалить комментарий",
      );
    }
  };

  const startSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!annotating || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    dragStart.current = position(event);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDraft(rectangle(dragStart.current, dragStart.current));
    setSelection(null);
  };
  const moveSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragStart.current)
      setDraft(rectangle(dragStart.current, position(event)));
  };
  const finishSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragStart.current) return;
    event.preventDefault();
    event.stopPropagation();
    const area = rectangle(dragStart.current, position(event));
    dragStart.current = null;
    setDraft(null);
    if (area.width >= 0.006 && area.height >= 0.006) {
      setSelection({ page: pageIndex + 1, ...area, text: "" });
      setCommentsOpen(true);
    }
  };

  return createPortal(
    <div
      className="pdf-book-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={dialog}
        className="pdf-book-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Документ: ${entry.title}`}
      >
        <header className="pdf-book-toolbar">
          <div className="pdf-book-toolbar-start">
            {outline.length > 0 && (
              <button
                type="button"
                className={outlineOpen ? "is-active" : ""}
                onClick={() => setOutlineOpen((open) => !open)}
                aria-label="Оглавление"
                aria-expanded={outlineOpen}
                title="Оглавление"
              >
                <List size={19} />
              </button>
            )}
            <strong>{entry.title}</strong>
          </div>
          <div className="pdf-book-actions">
            {!loading && !error && (
              <button
                type="button"
                className={magnifier ? "is-active" : ""}
                onClick={() => {
                  setAnnotating(false);
                  setSelection(null);
                  setMagnifier((value) => !value);
                }}
                aria-label="Лупа"
                aria-pressed={magnifier}
                title="Лупа: Escape для выхода"
              >
                <Search size={19} />
              </button>
            )}
            <button
              type="button"
              className="pdf-book-comments-toggle"
              onClick={() => setCommentsOpen((open) => !open)}
              aria-label="Комментарии"
              aria-expanded={commentsOpen}
            >
              <MessageSquare size={19} />
            </button>
            <button
              ref={closeButton}
              type="button"
              onClick={onClose}
              aria-label="Закрыть документ"
              title="Закрыть"
            >
              <X size={21} />
            </button>
          </div>
        </header>
        {(entry.documentType ||
          entry.documentDate ||
          entry.place ||
          entry.description ||
          entry.provenance ||
          onEdit) && (
          <details className="pdf-book-details">
            <summary>Сведения о документе</summary>
            <div>
              {entry.documentType && (
                <p>
                  <strong>Тип:</strong> {entry.documentType}
                </p>
              )}
              {entry.documentDate && (
                <p>
                  <strong>Дата:</strong> {entry.documentDate}
                </p>
              )}
              {entry.place && (
                <p>
                  <strong>Место:</strong> {entry.place}
                </p>
              )}
              {entry.provenance && (
                <p>
                  <strong>Происхождение:</strong> {entry.provenance}
                </p>
              )}
              {entry.description && (
                <p>
                  <strong>Описание:</strong> {entry.description}
                </p>
              )}
              {onEdit && (
                <button
                  type="button"
                  onClick={onEdit}
                  aria-label="Редактировать сведения о документе"
                >
                  Редактировать сведения
                </button>
              )}
            </div>
          </details>
        )}
        <div className="pdf-book-content">
          {outlineOpen && outline.length > 0 && (
            <nav className="pdf-book-outline" aria-label="Оглавление документа">
              <h2>Оглавление</h2>
              {outline.map((item, index) => (
                <button
                  type="button"
                  key={`${item.page}-${index}`}
                  style={{
                    paddingLeft: `${12 + Math.min(item.depth, 3) * 14}px`,
                  }}
                  onClick={() => {
                    setPageIndex(item.page);
                    setOutlineOpen(false);
                  }}
                >
                  <span>{item.title}</span>
                  <small>{item.page + 1}</small>
                </button>
              ))}
            </nav>
          )}
          <div className="pdf-book-stage">
            {loading && (
              <p className="pdf-book-message" role="status">
                Открываем документ…
              </p>
            )}
            {error && (
              <div className="pdf-book-message" role="alert">
                <p>{error}</p>
                <a
                  href={archiveResourceUrl(entry.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Открыть оригинал
                </a>
              </div>
            )}
            {!loading && !error && (
              <div
                ref={sheet}
                data-page={pageIndex}
                className={`pdf-reader-sheet${magnifier ? " is-magnifying" : ""}${annotating ? " is-annotating" : ""}`}
                onPointerDownCapture={(event) => {
                  if (magnifier) event.stopPropagation();
                }}
              >
                {pageUrls[pageIndex] ? (
                  <>
                    <img
                      src={pageUrls[pageIndex]}
                      alt={`Страница ${pageIndex + 1}`}
                    />
                    <div
                      className="pdf-book-overlay"
                      onPointerDown={startSelection}
                      onPointerMove={moveSelection}
                      onPointerUp={finishSelection}
                      onPointerCancel={() => {
                        dragStart.current = null;
                        setDraft(null);
                      }}
                    >
                      {annotations
                        .filter((item) => item.page === pageIndex + 1)
                        .map((item) => (
                          <span
                            key={item.id}
                            className={`pdf-book-highlight${item.id === activeAnnotation ? " is-active" : ""}`}
                            style={{
                              left: `${item.x * 100}%`,
                              top: `${item.y * 100}%`,
                              width: `${item.width * 100}%`,
                              height: `${item.height * 100}%`,
                            }}
                          />
                        ))}
                      {draft && (
                        <span
                          className="pdf-book-draft"
                          style={{
                            left: `${draft.x * 100}%`,
                            top: `${draft.y * 100}%`,
                            width: `${draft.width * 100}%`,
                            height: `${draft.height * 100}%`,
                          }}
                        />
                      )}
                      {selection?.page === pageIndex + 1 && (
                        <span
                          className="pdf-book-draft"
                          style={{
                            left: `${selection.x * 100}%`,
                            top: `${selection.y * 100}%`,
                            width: `${selection.width * 100}%`,
                            height: `${selection.height * 100}%`,
                          }}
                        />
                      )}
                    </div>
                  </>
                ) : (
                  <p role="status">Загружаем страницу…</p>
                )}
              </div>
            )}
          </div>
          <aside
            className={`pdf-book-comments${commentsOpen ? " is-open" : ""}`}
            aria-label="Комментарии к документу"
          >
            <div className="pdf-book-comments-heading">
              <h2>
                Комментарии <span>{annotations.length}</span>
              </h2>
              {mayAnnotate && !loading && !error && (
                <button
                  type="button"
                  onClick={() => {
                    setMagnifier(false);
                    setSelection(null);
                    setDraft(null);
                    setComment("");
                    setAnnotating((mode) => !mode);
                    setCommentsOpen(false);
                  }}
                  aria-label={
                    annotating ? "Отменить выделение" : "Выделить фрагмент"
                  }
                  aria-pressed={annotating}
                  title={
                    annotating ? "Отменить выделение" : "Выделить фрагмент"
                  }
                >
                  <MessageSquarePlus size={18} />
                </button>
              )}
            </div>
            {annotating && !selection && (
              <p className="pdf-book-comments-empty">
                Проведите по фрагменту страницы, чтобы оставить комментарий.
              </p>
            )}
            {selection && (
              <div className="pdf-book-comment-form">
                <label htmlFor="pdf-comment-text">
                  Страница {selection.page} · выделенный фрагмент
                </label>
                <textarea
                  id="pdf-comment-text"
                  aria-label="Комментарий к фрагменту"
                  maxLength={2000}
                  value={comment}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Что важно в этом фрагменте?"
                />
                <div>
                  <button
                    type="button"
                    onClick={() => void saveAnnotation()}
                    disabled={saving || !comment.trim()}
                  >
                    {saving ? "Сохраняем…" : "Сохранить комментарий"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setSelection(null);
                      setComment("");
                    }}
                  >
                    Отмена
                  </button>
                </div>
              </div>
            )}
            {annotationError && (
              <p role="alert" className="pdf-book-comments-error">
                {annotationError}
              </p>
            )}
            {!annotations.length &&
              !annotationError &&
              !selection &&
              !annotating && (
                <p className="pdf-book-comments-empty">
                  Комментариев пока нет.
                </p>
              )}
            <div className="pdf-book-comments-list">
              {annotations.map((item) => (
                <article
                  key={item.id}
                  className={item.id === activeAnnotation ? "is-active" : ""}
                >
                  <button
                    type="button"
                    disabled={loading || !!error}
                    onClick={() => {
                      setPageIndex(item.page - 1);
                      setActiveAnnotation(item.id);
                      setAnnotating(false);
                      setSelection(null);
                      setComment("");
                      setCommentsOpen(false);
                    }}
                  >
                    <small>
                      Страница {item.page} · {item.authorName}
                    </small>
                    <span>{item.text}</span>
                  </button>
                  {item.canDelete && (
                    <button
                      type="button"
                      className="pdf-book-comment-delete"
                      aria-label={`Удалить комментарий на странице ${item.page}`}
                      onClick={() => void removeAnnotation(item.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </article>
              ))}
            </div>
          </aside>
        </div>
        <footer className="pdf-book-footer">
          <div className="pdf-book-pagination">
            <button
              type="button"
              onClick={() => setPageIndex((index) => Math.max(0, index - 1))}
              disabled={loading || !!error || pageIndex === 0}
              aria-label="Предыдущая страница"
            >
              <ArrowLeft size={19} />
            </button>
            <span aria-live="polite">
              {pageCount ? `${pageIndex + 1} из ${pageCount}` : "—"}
            </span>
            <button
              type="button"
              onClick={() =>
                setPageIndex((index) => Math.min(pageCount - 1, index + 1))
              }
              disabled={loading || !!error || pageIndex >= pageCount - 1}
              aria-label="Следующая страница"
            >
              <ArrowRight size={19} />
            </button>
          </div>
          <a
            href={archiveResourceUrl(entry.url)}
            download={`${entry.title}.pdf`}
            className="pdf-book-download"
          >
            <Download size={16} />
            Скачать оригинал
          </a>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
