import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MessageSquarePlus, Pencil } from "lucide-react";
import { ConfirmDeleteButton } from "./confirm-delete-button";
import { DocumentCommentText } from "./document-comment-text";
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
  mayAnnotate = false,
  annotateOnOpen = false,
}: {
  document: ListedDocument;
  initialPage?: number;
  onClose: () => void;
  mayAnnotate?: boolean;
  annotateOnOpen?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const commentsList = useRef<HTMLDivElement>(null);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const editText = useRef<HTMLTextAreaElement | null>(null);
  const closeLatest = useRef(onClose);
  const magnifierLatest = useRef(false);
  const navigateToPage = useRef<((index: number) => void) | null>(null);
  const [readerReady, setReaderReady] = useState(false);
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [sidebarTab, setSidebarTab] = useState<
    "comments" | "outline" | "links"
  >("comments");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [magnifier, setMagnifier] = useState(false);
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([]);
  const [annotationError, setAnnotationError] = useState("");
  const [commentsOpen, setCommentsOpen] = useState(annotateOnOpen);
  const [annotating, setAnnotating] = useState(annotateOnOpen);
  const [selection, setSelection] = useState<AnnotationSelection | null>(null);
  const [comment, setComment] = useState("");
  const [editing, setEditing] = useState<{
    id: string;
    expected: string;
    text: string;
  } | null>(null);
  const [editError, setEditError] = useState("");
  const [saving, setSaving] = useState(false);
  const [activeAnnotation, setActiveAnnotation] = useState("");
  const [hoveredAnnotation, setHoveredAnnotation] = useState("");

  const editingId = editing?.id;
  useEffect(() => {
    if (editingId) editText.current?.focus();
    else editTrigger.current?.focus();
  }, [editingId]);

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
    const modal = dialog.current;
    modal?.showModal();
    frame.current?.focus();
    return () => {
      modal?.close();
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
          {
            source: "drevo-bookreader",
            type: "focus-search",
          } satisfies ReaderCommand,
          window.location.origin,
        );
      } else if (event.key === "Escape") {
        event.preventDefault();
        if (magnifierLatest.current) {
          event.preventDefault();
          magnifierLatest.current = false;
          setMagnifier(false);
        } else closeLatest.current();
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
            downloadName:
              entry.title +
              "." +
              (documentFileTypeFromMime(entry.mimeType || "application/pdf")
                ?.extension || "pdf"),
            metadata: [
              ["Тип", entry.documentType],
              ["Дата", entry.documentDate],
              ["Место", entry.place],
              ["Источник", entry.provenance],
              ["Описание", entry.description],
            ]
              .filter((item): item is [string, string] => !!item[1])
              .map(([label, value]) => ({ label, value })),
          } satisfies ReaderCommand,
          window.location.origin,
        );
        setReaderReady(true);
      } else if (message.type === "loaded") {
        setLoading(false);
      } else if (message.type === "toolbar-height") {
        if (
          Number.isFinite(message.height) &&
          message.height >= 0 &&
          message.height <= 240
        )
          dialog.current?.style.setProperty(
            "--reader-toolbar-height",
            `${message.height}px`,
          );
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
  ]);

  useEffect(() => {
    if (commentsOpen && sidebarTab === "comments" && activeAnnotation)
      commentsList.current
        ?.querySelector<HTMLElement>("article.is-active")
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

  const saveEditedAnnotation = async () => {
    if (!editing || !editing.text.trim() || saving) return;
    setSaving(true);
    setEditError("");
    try {
      const response = await archiveFetch(
        `/api/documents/${entry.id}/annotations/${editing.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expected: editing.expected,
            text: editing.text.trim(),
          }),
        },
      );
      const result = (await response.json()) as {
        items?: DocumentAnnotation[];
        error?: string;
        current?: string;
      };
      const current = result.current;
      if (response.status === 409 && typeof current === "string")
        setAnnotations((items) =>
          items.map((item) =>
            item.id === editing.id ? { ...item, text: current } : item,
          ),
        );
      if (!response.ok || !result.items)
        throw new Error(result.error || "Не удалось изменить комментарий");
      setAnnotations(result.items);
      setEditing(null);
    } catch (reason) {
      setEditError(
        reason instanceof Error
          ? reason.message
          : "Не удалось изменить комментарий",
      );
    } finally {
      setSaving(false);
    }
  };

  const removeAnnotation = async (id: string) => {
    if (saving) return;
    setSaving(true);
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
    } finally {
      setSaving(false);
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
      <dialog
        ref={dialog}
        className="pdf-book-dialog"
        aria-label={"Документ: " + entry.title}
        onCancel={(event) => {
          event.preventDefault();
          if (magnifierLatest.current) {
            magnifierLatest.current = false;
            setMagnifier(false);
          } else closeLatest.current();
        }}
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
              {(entry.eventLinks.length > 0 ||
                entry.pages.length > 0 ||
                entry.sources.length > 0) && (
                <button
                  type="button"
                  className={sidebarTab === "links" ? "is-active" : ""}
                  onClick={() => {
                    setSidebarTab("links");
                    setCommentsOpen(true);
                  }}
                  aria-pressed={sidebarTab === "links"}
                >
                  Связи
                </button>
              )}
            </div>
            {sidebarTab === "links" ? (
              <div className="pdf-book-links">
                {entry.eventLinks.length > 0 && (
                  <section>
                    <h3>События</h3>
                    {entry.eventLinks.map((link) => (
                      <p key={`${link.personId}:${link.eventId}`}>
                        {link.personName} · {link.eventTitle}
                        {link.page && (
                          <button
                            type="button"
                            onClick={() =>
                              navigateToPage.current?.(link.page! - 1)
                            }
                          >
                            Стр. {link.page}
                          </button>
                        )}
                      </p>
                    ))}
                  </section>
                )}
                {entry.sources.length > 0 && (
                  <section>
                    <h3>Источники</h3>
                    {entry.sources.map((source, index) => (
                      <p
                        key={`${source.personId}:${source.eventId || "card"}:${index}`}
                      >
                        {source.title} · {source.personName}
                        {source.assertions.length
                          ? ` · ${source.assertions.join("; ")}`
                          : ""}
                        {source.reference ? ` · ${source.reference}` : ""}
                        {source.page && (
                          <button
                            type="button"
                            onClick={() =>
                              navigateToPage.current?.(source.page! - 1)
                            }
                          >
                            Стр. {source.page}
                          </button>
                        )}
                      </p>
                    ))}
                  </section>
                )}
                {entry.pages.length > 0 && (
                  <section>
                    <h3>Страницы</h3>
                    {entry.pages.map((page) => (
                      <p key={page.number}>
                        <button
                          type="button"
                          onClick={() =>
                            navigateToPage.current?.(page.number - 1)
                          }
                        >
                          Стр. {page.number}
                        </button>{" "}
                        {page.description}
                      </p>
                    ))}
                  </section>
                )}
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
                    disabled={saving || !!editing}
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
                      role="presentation"
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
                      onClick={(event) => {
                        if (
                          loading ||
                          error ||
                          !(event.target instanceof Element)
                        )
                          return;
                        const control = event.target.closest(
                          "a, button, input, textarea, form",
                        );
                        if (
                          control &&
                          control !== event.currentTarget.firstElementChild
                        )
                          return;
                        const selected = window.getSelection();
                        if (
                          event.detail > 0 &&
                          selected &&
                          !selected.isCollapsed &&
                          (event.currentTarget.contains(selected.anchorNode) ||
                            event.currentTarget.contains(selected.focusNode))
                        )
                          return;
                        navigateToPage.current?.(item.page - 1);
                        setActiveAnnotation(item.id);
                        setAnnotating(false);
                        setSelection(null);
                        setComment("");
                      }}
                    >
                      <button
                        type="button"
                        aria-pressed={item.id === activeAnnotation}
                        disabled={loading || !!error}
                      >
                        <small>
                          Страница {item.page} · {item.authorName}
                        </small>
                      </button>
                      {editing?.id !== item.id && (
                        <DocumentCommentText text={item.text} />
                      )}
                      {item.canEdit && (
                        <button
                          type="button"
                          className="pdf-book-comment-edit"
                          hidden={editing?.id === item.id}
                          aria-label={
                            "Изменить комментарий на странице " + item.page
                          }
                          disabled={saving || !!editing}
                          onClick={(event) => {
                            editTrigger.current = event.currentTarget;
                            setEditing({
                              id: item.id,
                              expected: item.text,
                              text: item.text,
                            });
                            setEditError("");
                            setActiveAnnotation(item.id);
                            setAnnotating(false);
                            setSelection(null);
                            setComment("");
                          }}
                        >
                          <Pencil size={15} />
                        </button>
                      )}
                      {item.canDelete && (
                        <ConfirmDeleteButton
                          className="pdf-book-comment-delete"
                          disabled={saving || !!editing || !commentsOpen}
                          label={"Удалить комментарий на странице " + item.page}
                          confirmationLabel={
                            "Подтвердить удаление комментария на странице " +
                            item.page
                          }
                          onConfirm={() => void removeAnnotation(item.id)}
                        />
                      )}
                      {editing?.id === item.id && (
                        <form
                          className="pdf-book-comment-form"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveEditedAnnotation();
                          }}
                        >
                          <label htmlFor="pdf-comment-edit">
                            Изменить комментарий
                          </label>
                          <textarea
                            id="pdf-comment-edit"
                            ref={editText}
                            maxLength={2000}
                            disabled={saving}
                            value={editing.text}
                            onChange={(event) =>
                              setEditing({
                                ...editing,
                                text: event.target.value,
                              })
                            }
                            onKeyDown={(event) => {
                              if (event.key !== "Escape") return;
                              event.preventDefault();
                              event.stopPropagation();
                              if (!saving) {
                                setEditing(null);
                                setEditError("");
                              }
                            }}
                          />
                          {editError && (
                            <p role="alert" className="pdf-book-comments-error">
                              {editError}
                            </p>
                          )}
                          <div>
                            <button
                              type="submit"
                              disabled={
                                saving ||
                                !editing.text.trim() ||
                                editing.text.trim() === editing.expected
                              }
                            >
                              {saving ? "Сохраняем…" : "Сохранить"}
                            </button>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => {
                                setEditing(null);
                                setEditError("");
                              }}
                            >
                              Отмена
                            </button>
                          </div>
                        </form>
                      )}
                    </article>
                  ))}
                </div>
              </div>
            )}
          </aside>
        </div>
      </dialog>
    </div>,
    document.body,
  );
}
