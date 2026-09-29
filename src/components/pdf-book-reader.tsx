import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  MessageSquare,
  Trash2,
  X,
} from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageFlip } from "page-flip";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ListedDocument } from "./documents-catalog";
import type {
  AnnotationSelection,
  DocumentAnnotation,
} from "../shared/document-annotations";

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
  onClose,
  onDelete,
  mayAnnotate = false,
  annotateOnOpen = false,
  deleting = false,
  deleteError = "",
}: {
  document: ListedDocument;
  onClose: () => void;
  onDelete?: () => void;
  mayAnnotate?: boolean;
  annotateOnOpen?: boolean;
  deleting?: boolean;
  deleteError?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const book = useRef<PageFlip | null>(null);
  const closeLatest = useRef(onClose);
  const annotationMode = useRef(annotateOnOpen);
  const navigation = useRef(0);
  const navigationTarget = useRef<number | null>(null);
  const renderPage = useRef<(index: number) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    "landscape",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [annotations, setAnnotations] = useState<DocumentAnnotation[]>([]);
  const [annotationError, setAnnotationError] = useState("");
  const [selection, setSelection] = useState<AnnotationSelection | null>(null);
  const [comment, setComment] = useState("");
  const [saving, setSaving] = useState(false);
  const [annotating, setAnnotating] = useState(annotateOnOpen);
  const [activeAnnotation, setActiveAnnotation] = useState("");

  useEffect(() => {
    const request = new AbortController();
    void fetch(`/api/documents/${entry.id}/annotations`, {
      signal: request.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Не удалось загрузить комментарии");
        return response.json() as Promise<{ items: DocumentAnnotation[] }>;
      })
      .then((data) => setAnnotations(data.items))
      .catch((reason) => {
        if (!request.signal.aborted) setAnnotationError(String(reason.message));
      });
    return () => request.abort();
  }, [entry.id]);

  useEffect(() => {
    const root = host.current?.querySelector(".pdf-book-pages");
    if (!root) return;
    root
      .querySelectorAll<HTMLElement>(".pdf-book-highlight")
      .forEach((node) => node.remove());
    for (const item of annotations) {
      const page = root.querySelector<HTMLElement>(
        `.pdf-book-page[data-page="${item.page - 1}"]`,
      );
      const overlay = page?.querySelector<HTMLElement>(".pdf-book-overlay");
      if (!overlay) continue;
      const mark = document.createElement("span");
      mark.className = `pdf-book-highlight${item.id === activeAnnotation ? " is-active" : ""}`;
      mark.style.left = `${item.x * 100}%`;
      mark.style.top = `${item.y * 100}%`;
      mark.style.width = `${item.width * 100}%`;
      mark.style.height = `${item.height * 100}%`;
      overlay.append(mark);
    }
  }, [annotations, activeAnnotation, pageCount, loading]);

  useEffect(() => {
    annotationMode.current = annotating;
    host.current?.classList.toggle("is-annotating", annotating);
  }, [annotating]);

  useEffect(() => {
    const root = host.current?.querySelector(".pdf-book-pages");
    root?.querySelectorAll(".pdf-book-draft").forEach((node) => node.remove());
    if (!selection) return;
    const overlay = root?.querySelector<HTMLElement>(
      `.pdf-book-page[data-page="${selection.page - 1}"] .pdf-book-overlay`,
    );
    if (!overlay) return;
    const draft = document.createElement("span");
    draft.className = "pdf-book-draft";
    draft.style.left = `${selection.x * 100}%`;
    draft.style.top = `${selection.y * 100}%`;
    draft.style.width = `${selection.width * 100}%`;
    draft.style.height = `${selection.height * 100}%`;
    overlay.append(draft);
  }, [selection, loading]);

  useEffect(() => {
    closeLatest.current = onClose;
  }, [onClose]);
  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const keydown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLTextAreaElement
      )
        return;
      if (event.key === "Escape") closeLatest.current();
      else if (event.key === "ArrowRight") book.current?.flipNext();
      else if (event.key === "ArrowLeft") book.current?.flipPrev();
      else if (event.key === "Tab") {
        const controls = [
          ...(host.current
            ?.closest(".pdf-book-dialog")
            ?.querySelectorAll<HTMLElement>(
              "a[href], button:not([disabled])",
            ) || []),
        ];
        if (!controls.length) return;
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", keydown);
      previousFocus?.focus();
    };
  }, []);

  useEffect(() => {
    const navigationRef = navigation;
    const targetRef = navigationTarget;
    let active = true;
    let pdf: PDFDocumentProxy | null = null;
    let flip: PageFlip | null = null;
    let loadingTask: ReturnType<
      (typeof import("pdfjs-dist"))["getDocument"]
    > | null = null;
    let resize: ResizeObserver | null = null;
    const urls = new Map<number, string>();
    const pending = new Map<number, Promise<void>>();
    const root = document.createElement("div");
    root.className = "pdf-book-pages";
    host.current?.append(root);

    const alignOverlay = (index: number) => {
      for (const page of root.querySelectorAll<HTMLElement>(
        `[data-page="${index}"]`,
      )) {
        const image = page.querySelector("img");
        const overlay = page.querySelector<HTMLElement>(".pdf-book-overlay");
        if (!image?.naturalWidth || !image.naturalHeight || !overlay) continue;
        const fit = Math.min(
          page.clientWidth / image.naturalWidth,
          page.clientHeight / image.naturalHeight,
        );
        const width = image.naturalWidth * fit;
        const height = image.naturalHeight * fit;
        overlay.style.width = `${width}px`;
        overlay.style.height = `${height}px`;
        overlay.style.left = `${(page.clientWidth - width) / 2}px`;
        overlay.style.top = `${(page.clientHeight - height) / 2}px`;
      }
    };

    const showPage = (index: number, url: string) => {
      for (const image of root.querySelectorAll<HTMLImageElement>(
        `[data-page="${index}"] img`,
      ))
        image.src = url;
    };
    const render = (index: number): Promise<void> => {
      if (!pdf || index < 0 || index >= pdf.numPages || urls.has(index))
        return Promise.resolve();
      const existing = pending.get(index);
      if (existing) return existing;
      const task = (async () => {
        const page = await pdf!.getPage(index + 1);
        const original = page.getViewport({ scale: 1 });
        const scale = Math.min(
          2,
          1600 / Math.max(original.width, original.height),
        );
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
        urls.set(index, url);
        showPage(index, url);
        // Loading/parsing a PDF is not enough: CSP or decoding can still block
        // its rendered images. Report that instead of showing an empty book.
        await Promise.all(
          [
            ...root.querySelectorAll<HTMLImageElement>(
              `[data-page="${index}"] img`,
            ),
          ].map((image) => image.decode()),
        );
        alignOverlay(index);
      })().finally(() => pending.delete(index));
      pending.set(index, task);
      return task;
    };
    const renderNearby = (index: number) => {
      if (targetRef.current !== null && index !== targetRef.current) return;
      for (const [page, url] of urls) {
        if (Math.abs(page - index) <= 5 || page === targetRef.current) continue;
        for (const image of root.querySelectorAll<HTMLImageElement>(
          `[data-page="${page}"] img`,
        ))
          image.removeAttribute("src");
        URL.revokeObjectURL(url);
        urls.delete(page);
      }
      void (async () => {
        for (const page of [index, index + 1, index + 2, index - 1]) {
          if (!active) return;
          try {
            await render(page);
          } catch {
            if (active) setError("Не удалось загрузить одну из страниц PDF");
            return;
          }
        }
      })();
    };

    void (async () => {
      try {
        const [pdfjs, pageFlip] = await Promise.all([
          import("pdfjs-dist"),
          import("page-flip"),
        ]);
        if (!active) return;
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
        loadingTask = pdfjs.getDocument({
          url: entry.url,
          withCredentials: entry.url.startsWith("/"),
        });
        pdf = await loadingTask.promise;
        if (!active) return;
        if (pdf.numPages < 1 || pdf.numPages > 2000)
          throw new Error("Документ должен содержать от 1 до 2000 страниц");
        setPageCount(pdf.numPages);
        const pages = Array.from({ length: pdf.numPages }, (_, index) => {
          const item = document.createElement("div");
          item.className = "pdf-book-page";
          item.dataset.page = String(index);
          const image = document.createElement("img");
          image.alt = `Страница ${index + 1}`;
          image.onerror = () => {
            if (active) setError("Не удалось отобразить страницу PDF");
          };
          const number = document.createElement("span");
          number.textContent = String(index + 1);
          const overlay = document.createElement("div");
          overlay.className = "pdf-book-overlay";
          let start: { x: number; y: number } | null = null;
          const position = (event: PointerEvent) => {
            const bounds = overlay.getBoundingClientRect();
            return {
              x: Math.max(
                0,
                Math.min(1, (event.clientX - bounds.left) / bounds.width),
              ),
              y: Math.max(
                0,
                Math.min(1, (event.clientY - bounds.top) / bounds.height),
              ),
            };
          };
          overlay.addEventListener("pointerdown", (event) => {
            if (!annotationMode.current || event.button !== 0) return;
            event.preventDefault();
            event.stopPropagation();
            start = position(event);
            overlay.setPointerCapture(event.pointerId);
            overlay.querySelector(".pdf-book-draft")?.remove();
            const draft = document.createElement("span");
            draft.className = "pdf-book-draft";
            overlay.append(draft);
          });
          overlay.addEventListener("mousedown", (event) => {
            if (annotationMode.current) {
              event.preventDefault();
              event.stopPropagation();
            }
          });
          overlay.addEventListener(
            "touchstart",
            (event) => {
              if (annotationMode.current) {
                event.stopPropagation();
              }
            },
            { passive: true },
          );
          overlay.addEventListener("pointermove", (event) => {
            if (!start) return;
            const end = position(event);
            const draft = overlay.querySelector<HTMLElement>(".pdf-book-draft");
            if (!draft) return;
            draft.style.left = `${Math.min(start.x, end.x) * 100}%`;
            draft.style.top = `${Math.min(start.y, end.y) * 100}%`;
            draft.style.width = `${Math.abs(start.x - end.x) * 100}%`;
            draft.style.height = `${Math.abs(start.y - end.y) * 100}%`;
          });
          overlay.addEventListener("pointerup", (event) => {
            if (!start) return;
            event.preventDefault();
            event.stopPropagation();
            const end = position(event);
            const next = {
              page: index + 1,
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(start.x - end.x),
              height: Math.abs(start.y - end.y),
              text: "",
            };
            start = null;
            if (next.width >= 0.006 && next.height >= 0.006) setSelection(next);
            else overlay.querySelector(".pdf-book-draft")?.remove();
          });
          overlay.addEventListener("pointercancel", () => {
            start = null;
            overlay.querySelector(".pdf-book-draft")?.remove();
          });
          item.append(image, overlay, number);
          root.append(item);
          return item;
        });
        await render(0);
        if (!active) return;
        const firstPage = await pdf.getPage(1);
        if (!active) return;
        const pageSize = firstPage.getViewport({ scale: 1 });
        flip = new pageFlip.PageFlip(root, {
          width: pageSize.width,
          height: pageSize.height,
          size: "stretch",
          minWidth: 300,
          maxWidth: 1600,
          minHeight: 100,
          maxHeight: 2400,
          showCover: true,
          usePortrait: true,
          autoSize: false,
          flippingTime: window.matchMedia("(prefers-reduced-motion: reduce)")
            .matches
            ? 1
            : 550,
          maxShadowOpacity: 0.32,
          mobileScrollSupport: false,
        });
        book.current = flip;
        renderPage.current = render;
        const centerBook = () => {
          if (!flip || !pdf) return;
          const index = flip.getCurrentPageIndex();
          const shift =
            flip.getOrientation() !== "landscape"
              ? 0
              : index === pdf.numPages - 1 &&
                  (pdf.numPages === 1 || pdf.numPages % 2 === 0)
                ? 0.5
                : index === 0
                  ? -0.5
                  : 0;
          root.style.transform = `translateX(${shift * flip.getBoundsRect().pageWidth}px)`;
        };
        flip.on("flip", ({ data }) => {
          if (!active) return;
          setPageIndex(data);
          renderNearby(data);
          centerBook();
          requestAnimationFrame(() => {
            if (!active) return;
            alignOverlay(data);
            alignOverlay(data + 1);
          });
        });
        flip.on("changeOrientation", ({ data }) => {
          if (!active) return;
          setOrientation(data);
          for (const [index, url] of urls) showPage(index, url);
          centerBook();
          requestAnimationFrame(() => {
            if (active) for (const index of urls.keys()) alignOverlay(index);
          });
        });
        flip.loadFromHTML(pages);
        resize = new ResizeObserver(() => {
          if (active) {
            flip?.update();
            centerBook();
            for (const index of urls.keys()) alignOverlay(index);
          }
        });
        if (host.current) resize.observe(host.current);
        setOrientation(flip.getOrientation());
        setLoading(false);
        renderNearby(0);
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
      book.current = null;
      renderPage.current = () => Promise.resolve();
      navigationRef.current++;
      targetRef.current = null;
      resize?.disconnect();
      flip?.destroy();
      void loadingTask?.destroy();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      root.remove();
    };
  }, [entry.url]);

  const saveAnnotation = async () => {
    if (!selection || !comment.trim()) return;
    setSaving(true);
    setAnnotationError("");
    try {
      const response = await fetch(`/api/documents/${entry.id}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...selection, text: comment.trim() }),
      });
      const data = (await response.json()) as {
        items?: DocumentAnnotation[];
        error?: string;
      };
      if (!response.ok || !data.items)
        throw new Error(data.error || "Не удалось сохранить комментарий");
      setAnnotations(data.items);
      setActiveAnnotation(data.items.at(-1)?.id || "");
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
      const response = await fetch(
        `/api/documents/${entry.id}/annotations/${id}`,
        { method: "DELETE" },
      );
      const data = (await response.json()) as {
        items?: DocumentAnnotation[];
        error?: string;
      };
      if (!response.ok || !data.items)
        throw new Error(data.error || "Не удалось удалить комментарий");
      setAnnotations(data.items);
      if (activeAnnotation === id) setActiveAnnotation("");
    } catch (reason) {
      setAnnotationError(
        reason instanceof Error
          ? reason.message
          : "Не удалось удалить комментарий",
      );
    }
  };

  const openAnnotation = async (item: DocumentAnnotation) => {
    const flip = book.current;
    if (!flip) return;
    const token = ++navigation.current;
    navigationTarget.current = item.page - 1;
    setAnnotating(false);
    setSelection(null);
    setComment("");
    setActiveAnnotation("");
    await renderPage.current(item.page - 1).catch(() => {});
    if (token !== navigation.current || !book.current) return;
    const target = item.page - 1;
    let current = flip.getCurrentPageIndex();
    const distance = Math.abs(target - current);
    const step = target > current ? 1 : -1;
    const delay = Math.max(14, Math.min(50, 1800 / Math.max(1, distance)));
    while (
      current !== target &&
      token === navigation.current &&
      book.current === flip
    ) {
      current += step;
      flip.turnToPage(current);
      if (current !== target)
        await new Promise((resolve) => window.setTimeout(resolve, delay));
    }
    if (token === navigation.current && book.current === flip) {
      navigationTarget.current = null;
      void renderPage.current(target + 1).catch(() => {});
      setActiveAnnotation(item.id);
    }
  };

  const end =
    orientation === "landscape" && pageIndex > 0
      ? Math.min(pageCount, pageIndex + 2)
      : pageIndex + 1;
  const pageLabel =
    pageIndex + 1 === end
      ? `${end} из ${pageCount}`
      : `${pageIndex + 1}–${end} из ${pageCount}`;

  return createPortal(
    <div
      className="pdf-book-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="pdf-book-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`Документ: ${entry.title}`}
      >
        <header className="pdf-book-toolbar">
          <div>
            <strong>{entry.title}</strong>
          </div>
          <div className="pdf-book-actions">
            {onDelete && (
              <button
                type="button"
                onClick={onDelete}
                disabled={deleting}
                aria-label="Удалить документ"
                title="Удалить документ"
              >
                <Trash2 size={18} />
              </button>
            )}
            <a
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Открыть оригинал"
            >
              <ExternalLink size={18} />
              <span>Оригинал</span>
            </a>
            <a href="#pdf-book-notes" className="pdf-book-notes-link">
              <MessageSquare size={17} />
              <span>Комментарии {annotations.length || ""}</span>
            </a>
            <button
              ref={closeButton}
              type="button"
              onClick={onClose}
              aria-label="Закрыть документ"
            >
              <X size={21} />
            </button>
          </div>
        </header>
        {(entry.documentType || entry.documentDate || entry.place || entry.description || entry.provenance) && (
          <details className="pdf-book-details">
            <summary>Сведения о документе</summary>
            <div>
              {entry.documentType && <p><strong>Тип:</strong> {entry.documentType}</p>}
              {entry.documentDate && <p><strong>Дата:</strong> {entry.documentDate}</p>}
              {entry.place && <p><strong>Место:</strong> {entry.place}</p>}
              {entry.provenance && <p><strong>Происхождение:</strong> {entry.provenance}</p>}
              {entry.description && <p><strong>Описание:</strong> {entry.description}</p>}
            </div>
          </details>
        )}
        {deleteError && (
          <p className="pdf-book-delete-error" role="alert">
            {deleteError}
          </p>
        )}
        <div className="pdf-book-content">
          <div className="pdf-book-stage">
            <div
              ref={host}
              className="pdf-book-host"
              aria-label="Страницы PDF"
              aria-busy={loading}
              style={{ visibility: loading || error ? "hidden" : "visible" }}
            />
            {loading && (
              <p className="pdf-book-message" role="status">
                Открываем документ…
              </p>
            )}
            {error && (
              <div className="pdf-book-message" role="alert">
                <p>{error}</p>
                <p>Попробуйте открыть исходный PDF, чтобы проверить файл.</p>
                <a href={entry.url} target="_blank" rel="noopener noreferrer">
                  Открыть оригинал
                </a>
              </div>
            )}
          </div>
          <aside
            id="pdf-book-notes"
            className="pdf-book-notes"
            aria-label="Комментарии к документу"
          >
            <div className="pdf-book-notes-heading">
              <strong>
                Комментарии <span>{annotations.length}</span>
              </strong>
              {mayAnnotate && !loading && !error && (
                <button
                  type="button"
                  onClick={() => {
                    setSelection(null);
                    setComment("");
                    setAnnotating((current) => !current);
                  }}
                  aria-pressed={annotating}
                >
                  {annotating ? "Отменить выделение" : "Выделить фрагмент"}
                </button>
              )}
            </div>
            {annotating && (
              <p className="pdf-book-hint">
                Проведите по нужному фрагменту страницы, затем напишите
                комментарий.
              </p>
            )}
            {selection && (
              <div className="pdf-book-comment-form">
                <small>Страница {selection.page} · выделенный фрагмент</small>
                <textarea
                  aria-label="Комментарий к фрагменту"
                  value={comment}
                  maxLength={2000}
                  onChange={(event) => setComment(event.target.value)}
                  placeholder="Что важно в этом фрагменте?"
                />
                <div>
                  <button
                    type="button"
                    onClick={() => void saveAnnotation()}
                    disabled={!comment.trim() || saving}
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
              <p className="pdf-book-note-error" role="alert">
                {annotationError}
              </p>
            )}
            {!annotations.length && !selection && (
              <p className="pdf-book-hint">
                Пока нет комментариев к страницам.
              </p>
            )}
            <ol className="pdf-book-note-list">
              {annotations.map((item) => (
                <li
                  key={item.id}
                  className={item.id === activeAnnotation ? "is-active" : ""}
                >
                  <button
                    type="button"
                    disabled={loading || !!error}
                    onClick={() => void openAnnotation(item)}
                  >
                    <small>
                      Страница {item.page} · {item.authorName}
                    </small>
                    <span>{item.text}</span>
                  </button>
                  {item.canDelete && (
                    <button
                      type="button"
                      className="pdf-book-note-delete"
                      aria-label={`Удалить комментарий на странице ${item.page}`}
                      onClick={() => void removeAnnotation(item.id)}
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </li>
              ))}
            </ol>
          </aside>
        </div>
        {!loading && !error && (
          <footer className="pdf-book-footer">
            <button
              type="button"
              onClick={() => book.current?.flipPrev()}
              disabled={pageIndex === 0}
              aria-label="Предыдущая страница"
            >
              <ArrowLeft size={20} />
            </button>
            <span aria-live="polite">{pageLabel}</span>
            <button
              type="button"
              onClick={() => book.current?.flipNext()}
              disabled={end >= pageCount}
              aria-label="Следующая страница"
            >
              <ArrowRight size={20} />
            </button>
          </footer>
        )}
      </section>
    </div>,
    document.body,
  );
}
