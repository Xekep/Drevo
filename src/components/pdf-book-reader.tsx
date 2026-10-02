import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus, Trash2 } from "lucide-react";
import type { ReaderCommand, ReaderEvent } from "./bookreader-frame-messages";
import type { ListedDocument } from "./documents-catalog";
import { documentFileTypeFromMime } from "../shared/document-file.ts";
import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import type {
  AnnotationSelection,
  DocumentAnnotation,
} from "../shared/document-annotations";

type OutlineEntry = { title: string; page: number; depth: number };

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
  const dialog = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const commentsList = useRef<HTMLDivElement>(null);
  const closeLatest = useRef(onClose);
  const editLatest = useRef(onEdit);
  const magnifierLatest = useRef(false);
  const navigateToPage = useRef<((index: number) => void) | null>(null);
  const [readerReady, setReaderReady] = useState(false);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [sidebarTab, setSidebarTab] = useState<"comments" | "outline" | "links">(
    "comments",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [magnifier, setMagnifier] = useState(false);
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([]);
  const [annotationError, setAnnotationError] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(annotateOnOpen);
  const [annotating, setAnnotating] = useState(annotateOnOpen);
  const [selection, setSelection] = useState<AnnotationSelection | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeAnnotation, setActiveAnnotation] = useState("");
  const [hoveredAnnotation, setHoveredAnnotation] = useState("");

  useEffect(() => {
    closeLatest.current = onClose;
  }, [onClose]);
  useEffect(() => {
    editLatest.current = onEdit;
  }, [onEdit]);
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
    frame.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, []);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "f" &&
        (!entry.mimeType || entry.mimeType === "application/pdf")
      ) {
        event.preventDefault();
        frame.current?.contentWindow?.postMessage(
          { source: "drevo-bookreader", type: "focus-search" } satisfies ReaderCommand,
          window.location.origin,
        );
      } else if (event.key === "Escape") {
        if (magnifierLatest.current) {
          event.preventDefault();
          magnifierLatest.current = false;
          setMagnifier(false);
        } else closeLatest.current();
      } else if (event.key === "Tab") {
        const controls = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            "a[href], button:not([disabled]), textarea:not([disabled]), iframe",
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
  }, [entry.mimeType]);

  useEffect(() => {
    const onMessage = (event: MessageEvent<ReaderEvent>) => {
      if (
        event.origin !== window.location.origin ||
        event.source !== frame.current?.contentWindow ||
        event.data?.source !== "drevo-bookreader"
      )
        return;
      const message = event.data;
      if (message.type === "ready") {
        frame.current?.contentWindow?.postMessage(
          {
            source: "drevo-bookreader",
            type: "init",
            url: archiveResourceUrl(entry.url),
            mimeType: entry.mimeType || "application/pdf",
            initialPage,
            title: entry.title,
            downloadName: entry.title + "." +
              (documentFileTypeFromMime(entry.mimeType || "application/pdf")?.extension || "pdf"),
            metadata: [
              ["Тип", entry.documentType],
              ["Дата", entry.documentDate],
              ["Место", entry.place],
              ["Источник", entry.provenance],
              ["Описание", entry.description],
            ]
              .filter((item): item is [string, string] => !!item[1])
              .map(([label, value]) => ({ label, value })),
            canEdit: !!onEdit,
          } satisfies ReaderCommand,
          window.location.origin,
        );
        setReaderReady(true);
      } else if (message.type === "loaded") {
        setLoading(false);
      } else if (message.type === "toolbar-height") {
        if (Number.isFinite(message.height) && message.height >= 0 && message.height <= 240)
          dialog.current?.style.setProperty("--reader-toolbar-height", `${message.height}px`);
      } else if (message.type === "outline") {
        setOutline(message.items);
      } else if (message.type === "selection") {
        setSelection(message.selection);
        setSidebarTab("comments");
        setCommentsOpen(true);
      } else if (message.type === "annotation") {
        setActiveAnnotation(message.id);
        setSidebarTab("comments");
        setCommentsOpen(true);
        setAnnotating(false);
        setSelection(null);
        setComment("");
      } else if (message.type === "magnifier-off") {
        setMagnifier(false);
      } else if (message.type === "toggle-magnifier") {
        setAnnotating(false);
        setSelection(null);
        setMagnifier((value) => !value);
      } else if (message.type === "toggle-comments") {
        setCommentsOpen((value) => !value);
      } else if (message.type === "edit") {
        editLatest.current?.();
      } else if (message.type === "close") {
        closeLatest.current();
      } else if (message.type === "error") {
        setError(message.message);
        setLoading(false);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [
    entry.url,
    entry.mimeType,
    entry.title,
    entry.documentType,
    entry.documentDate,
    entry.place,
    entry.provenance,
    entry.description,
    initialPage,
    onEdit,
  ]);

  useEffect(() => {
    if (commentsOpen && sidebarTab === "comments" && activeAnnotation)
      commentsList.current?.querySelector<HTMLElement>("article.is-active")
        ?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [activeAnnotation, commentsOpen, sidebarTab]);

  useEffect(() => {
    if (!readerReady) return;
    frame.current?.contentWindow?.postMessage(
      {
        source: "drevo-bookreader",
        type: "state",
        annotations,
        activeAnnotation,
        hoveredAnnotation,
        annotating,
        magnifier,
        commentsOpen,
        selection,
      } satisfies ReaderCommand,
      window.location.origin,
    );
  }, [
    readerReady,
    annotations,
    activeAnnotation,
    hoveredAnnotation,
    annotating,
    magnifier,
    commentsOpen,
    selection,
  ]);

  useEffect(() => {
    if (!readerReady) return;
    frame.current?.contentWindow?.postMessage(
      {
        source: "drevo-bookreader",
        type: "jump",
        page: initialPage - 1,
      } satisfies ReaderCommand,
      window.location.origin,
    );
  }, [initialPage, readerReady]);

  useEffect(() => {
    navigateToPage.current = (page) => {
      frame.current?.contentWindow?.postMessage(
        {
          source: "drevo-bookreader",
          type: "jump",
          page,
        } satisfies ReaderCommand,
        window.location.origin,
      );
    };
    return () => {
      navigateToPage.current = null;
    };
  }, []);

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
        aria-label={"Документ: " + entry.title}
        onContextMenu={(event) => {
          if (!magnifierLatest.current) return;
          event.preventDefault();
          magnifierLatest.current = false;
          setMagnifier(false);
        }}
      >
        <div className="pdf-book-content">
          <div className="pdf-book-stage">
            <div className="pdf-book-host">
              <iframe
                ref={frame}
                className="pdf-book-frame"
                src="/bookreader-frame.html"
                title="Страницы документа"
                aria-busy={loading}
                style={{
                  visibility: loading || !!error ? "hidden" : "visible",
                }}
              />
            </div>
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
                <button type="button" onClick={onClose}>
                  Закрыть документ
                </button>
              </div>
            )}
          </div>
          <aside
            className={"pdf-book-sidebar" + (commentsOpen ? " is-open" : "")}
            aria-label="Комментарии и оглавление"
          >
            <div className="pdf-book-sidebar-tabs">
              <button
                type="button"
                className={sidebarTab === "comments" ? "is-active" : ""}
                onClick={() => setSidebarTab("comments")}
                aria-pressed={sidebarTab === "comments"}
              >
                Комментарии{annotations.length ? " " + annotations.length : ""}
              </button>
              {outline.length > 0 && (
                <button
                  type="button"
                  className={sidebarTab === "outline" ? "is-active" : ""}
                  onClick={() => setSidebarTab("outline")}
                  aria-pressed={sidebarTab === "outline"}
                >
                  Оглавление
                </button>
              )}
              {(entry.eventLinks.length > 0 || entry.pages.length > 0 || entry.sources.length > 0) && (
                <button type="button" className={sidebarTab === "links" ? "is-active" : ""}
                  onClick={() => { setSidebarTab("links"); setCommentsOpen(true); }}
                  aria-pressed={sidebarTab === "links"}>Связи</button>
              )}
            </div>
            {sidebarTab === "links" ? (
              <div className="pdf-book-links">
                {entry.eventLinks.length > 0 && <section><h3>События</h3>{entry.eventLinks.map((link) => (
                  <p key={`${link.personId}:${link.eventId}`}>{link.personName} · {link.eventTitle}{link.page &&
                    <button type="button" onClick={() => navigateToPage.current?.(link.page! - 1)}>Стр. {link.page}</button>}</p>
                ))}</section>}
                {entry.sources.length > 0 && <section><h3>Источники</h3>{entry.sources.map((source, index) => (
                  <p key={`${source.personId}:${source.eventId || "card"}:${index}`}>{source.title} · {source.personName}{source.eventTitle ? ` · ${source.eventTitle}` : ""}
                    {source.reference ? ` · ${source.reference}` : ""}{source.page &&
                    <button type="button" onClick={() => navigateToPage.current?.(source.page! - 1)}>Стр. {source.page}</button>}</p>
                ))}</section>}
                {entry.pages.length > 0 && <section><h3>Страницы</h3>{entry.pages.map((page) => (
                  <p key={page.number}><button type="button" onClick={() => navigateToPage.current?.(page.number - 1)}>Стр. {page.number}</button> {page.description}</p>
                ))}</section>}
              </div>
            ) : sidebarTab === "outline" && outline.length > 0 ? (
              <nav
                className="pdf-book-outline"
                aria-label="Оглавление документа"
              >
                {outline.map((item, index) => (
                  <button
                    type="button"
                    key={item.page + "-" + index}
                    style={{
                      paddingLeft: 14 + Math.min(item.depth, 3) * 14 + "px",
                    }}
                    onClick={() => {
                      navigateToPage.current?.(item.page);
                      setCommentsOpen(false);
                    }}
                  >
                    <span>{item.title}</span>
                    <small>{item.page + 1}</small>
                  </button>
                ))}
              </nav>
            ) : (
              <div className="pdf-book-comments">
                {mayAnnotate && !loading && !error && (
                  <button
                    type="button"
                    className={
                      "pdf-book-add-comment" + (annotating ? " is-active" : "")
                    }
                    onClick={() => {
                      setMagnifier(false);
                      setSelection(null);
                      setComment("");
                      setAnnotating((mode) => !mode);
                      setCommentsOpen(false);
                    }}
                    aria-label={
                      annotating ? "Отменить выделение" : "Выделить фрагмент"
                    }
                    aria-pressed={annotating}
                  >
                    <MessageSquarePlus size={16} />
                    <span>
                      {annotating
                        ? "Отменить выделение"
                        : "Добавить комментарий"}
                    </span>
                  </button>
                )}
                {annotating && !selection && (
                  <p className="pdf-book-comments-empty">
                    Выделите фрагмент на странице.
                  </p>
                )}
                {selection && (
                  <div className="pdf-book-comment-form">
                    <label htmlFor="pdf-comment-text">
                      Страница {selection.page}
                    </label>
                    <textarea
                      id="pdf-comment-text"
                      aria-label="Комментарий к фрагменту"
                      maxLength={2000}
                      value={comment}
                      onChange={(event) => setComment(event.target.value)}
                      placeholder="Комментарий"
                    />
                    <div>
                      <button
                        type="button"
                        onClick={() => void saveAnnotation()}
                        disabled={saving || !comment.trim()}
                      >
                        {saving ? "Сохраняем…" : "Сохранить"}
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
                  !selection &&
                  !annotating &&
                  !annotationError && (
                    <p className="pdf-book-comments-empty">
                      Комментариев пока нет.
                    </p>
                  )}
                <div className="pdf-book-comments-list" ref={commentsList}>
                  {annotations.map((item) => (
                    <article
                      key={item.id}
                      className={
                        item.id === activeAnnotation ? "is-active" : ""
                      }
                      onMouseEnter={() => setHoveredAnnotation(item.id)}
                      onMouseLeave={() => setHoveredAnnotation("")}
                      onFocus={() => setHoveredAnnotation(item.id)}
                      onBlur={(event) => {
                        if (!event.currentTarget.contains(event.relatedTarget))
                          setHoveredAnnotation("");
                      }}
                    >
                      <button
                        type="button"
                        aria-pressed={item.id === activeAnnotation}
                        disabled={loading || !!error}
                        onClick={() => {
                          navigateToPage.current?.(item.page - 1);
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
                          aria-label={
                            "Удалить комментарий на странице " + item.page
                          }
                          onClick={() => void removeAnnotation(item.id)}
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </section>
    </div>,
    document.body,
  );
}
