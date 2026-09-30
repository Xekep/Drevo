import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Download,
  MessageSquare,
  MessageSquarePlus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { LensZoom } from "@jojovms/lens-zoom-core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageFlip } from "page-flip";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ListedDocument } from "./documents-catalog";
import { archiveFetch } from "../data/archive-fetch.ts";
import { archiveResourceUrl } from "../domain/archive-context.ts";
import type {
  AnnotationSelection,
  DocumentAnnotation,
} from "../shared/document-annotations";

type OutlineEntry = { title: string; page: number; depth: number };

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
  const host = useRef<HTMLDivElement>(null);
  const book = useRef<PageFlip | null>(null);
  const closeLatest = useRef(onClose);
  const magnifierLatest = useRef(false);
  const annotationMode = useRef(annotateOnOpen);
  const renderPage = useRef<(index: number) => Promise<void>>(() =>
    Promise.resolve(),
  );
  const navigateToPage = useRef<((index: number) => void) | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(Math.max(0, initialPage - 1));
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    "portrait",
  );
  const [outline, setOutline] = useState<OutlineEntry[]>([]);
  const [sidebarTab, setSidebarTab] = useState<"comments" | "outline">(
    "comments",
  );
  const [infoOpen, setInfoOpen] = useState(false);
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

  useEffect(() => {
    closeLatest.current = onClose;
  }, [onClose]);
  useEffect(() => {
    magnifierLatest.current = magnifier;
    host.current?.classList.toggle("is-magnifying", magnifier);
  }, [magnifier]);
  useEffect(() => {
    annotationMode.current = annotating;
    host.current?.classList.toggle("is-annotating", annotating);
  }, [annotating, loading]);
  useEffect(() => {
    const root = host.current?.querySelector(".pdf-book-pages");
    if (!root) return;
    root
      .querySelectorAll(".pdf-book-highlight, .pdf-book-draft")
      .forEach((node) => node.remove());
    for (const item of annotations) {
      const overlay = root.querySelector<HTMLElement>(
        `.pdf-book-page[data-page="${item.page - 1}"] .pdf-book-overlay`,
      );
      if (!overlay) continue;
      const mark = document.createElement("span");
      mark.className = `pdf-book-highlight${item.id === activeAnnotation ? " is-active" : ""}`;
      Object.assign(mark.style, {
        left: `${item.x * 100}%`,
        top: `${item.y * 100}%`,
        width: `${item.width * 100}%`,
        height: `${item.height * 100}%`,
      });
      overlay.append(mark);
    }
    if (selection) {
      const overlay = root.querySelector<HTMLElement>(
        `.pdf-book-page[data-page="${selection.page - 1}"] .pdf-book-overlay`,
      );
      if (overlay) {
        const mark = document.createElement("span");
        mark.className = "pdf-book-draft";
        Object.assign(mark.style, {
          left: `${selection.x * 100}%`,
          top: `${selection.y * 100}%`,
          width: `${selection.width * 100}%`,
          height: `${selection.height * 100}%`,
        });
        overlay.append(mark);
      }
    }
  }, [annotations, activeAnnotation, selection, loading]);

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
        } else if (infoOpen) setInfoOpen(false);
        else closeLatest.current();
      } else if (
        event.key === "ArrowRight" &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLInputElement)
      ) {
        book.current?.flipNext();
      } else if (
        event.key === "ArrowLeft" &&
        !(event.target instanceof HTMLTextAreaElement) &&
        !(event.target instanceof HTMLInputElement)
      ) {
        book.current?.flipPrev();
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
  }, [infoOpen]);

  useEffect(() => {
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
      for (const [page, url] of urls) {
        if (Math.abs(page - index) <= 5) continue;
        for (const image of root.querySelectorAll<HTMLImageElement>(
          `[data-page="${page}"] img`,
        ))
          image.removeAttribute("src");
        URL.revokeObjectURL(url);
        urls.delete(page);
      }
      for (const page of [index + 1, index + 2, index + 3, index, index - 1])
        void render(page).catch(() => {
          if (active) setError("Не удалось загрузить страницу PDF");
        });
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
          url: archiveResourceUrl(entry.url),
          withCredentials: entry.url.startsWith("/"),
        });
        pdf = await loadingTask.promise;
        if (!active) return;
        if (pdf.numPages < 1 || pdf.numPages > 2000)
          throw new Error("Документ должен содержать от 1 до 2000 страниц");
        setPageCount(pdf.numPages);
        const firstIndex = Math.min(
          pdf.numPages - 1,
          Math.max(0, initialPage - 1),
        );
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
            // A damaged outline must not stop valid pages from opening.
          }
        })();
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
            if (next.width >= 0.006 && next.height >= 0.006) {
              setSelection(next);
              setSidebarTab("comments");
              setCommentsOpen(true);
            } else overlay.querySelector(".pdf-book-draft")?.remove();
          });
          overlay.addEventListener("pointercancel", () => {
            start = null;
            overlay.querySelector(".pdf-book-draft")?.remove();
          });
          item.append(image, overlay, number);
          root.append(item);
          return item;
        });
        await Promise.all([
          render(firstIndex),
          render(firstIndex + 1),
          render(firstIndex + 2),
        ]);
        if (!active) return;
        const firstPage = await pdf.getPage(1);
        if (!active) return;
        const pageSize = firstPage.getViewport({ scale: 1 });
        const reducedMotion = window.matchMedia(
          "(prefers-reduced-motion: reduce)",
        ).matches;
        const flipDuration = reducedMotion ? 1 : 550;
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
          flippingTime: flipDuration,
          maxShadowOpacity: 0.32,
          mobileScrollSupport: false,
        });
        book.current = flip;
        renderPage.current = render;
        navigateToPage.current = (index) => {
          if (!flip || !pdf || index < 0 || index >= pdf.numPages) return;
          void render(index)
            .then(() => {
              if (!active || !flip) return;
              flip.turnToPage(index);
              renderNearby(index);
            })
            .catch(() => {
              if (active) setError("Не удалось загрузить страницу PDF");
            });
        };
        const centerBook = (index: number, animate = false) => {
          if (!flip || !pdf) return;
          const shift =
            flip.getOrientation() !== "landscape"
              ? 0
              : index === pdf.numPages - 1 &&
                  (pdf.numPages === 1 || pdf.numPages % 2 === 0)
                ? 0.5
                : index === 0
                  ? -0.5
                  : 0;
          const transform = `translateX(${shift * flip.getBoundsRect().pageWidth}px)`;
          if (root.style.transform === transform) return;
          root.style.transition =
            animate && !reducedMotion
              ? `transform ${flipDuration}ms cubic-bezier(0.22, 1, 0.36, 1)`
              : "none";
          root.style.transform = transform;
        };
        flip.on("changeState", ({ data }) => {
          if (!active || data !== "flipping" || !flip || !pdf) return;
          const direction = flip
            .getFlipController()
            .getCalculation()
            ?.getDirection();
          if (direction === undefined) return;
          const index = flip.getCurrentPageIndex();
          const target =
            direction === 0
              ? index === 0
                ? 1
                : Math.min(index + 2, pdf.numPages - 1)
              : index === 1
                ? 0
                : Math.max(0, index - 2);
          centerBook(target, true);
        });
        flip.on("flip", ({ data }) => {
          if (!active) return;
          setPageIndex(data);
          renderNearby(data);
          centerBook(data);
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
          centerBook(flip?.getCurrentPageIndex() ?? 0);
          requestAnimationFrame(() => {
            if (active) for (const index of urls.keys()) alignOverlay(index);
          });
        });
        flip.loadFromHTML(pages);
        // showCover forces rigid end pages; keep its single-page spread but fold paper softly.
        flip.getPage(0).setDensity("soft");
        if (pdf.numPages > 1) flip.getPage(pdf.numPages - 1).setDensity("soft");
        if (firstIndex > 0) flip.turnToPage(firstIndex);
        resize = new ResizeObserver(() => {
          if (active) {
            flip?.update();
            centerBook(flip?.getCurrentPageIndex() ?? 0);
            for (const index of urls.keys()) alignOverlay(index);
          }
        });
        if (host.current) resize.observe(host.current);
        setOrientation(flip.getOrientation());
        setLoading(false);
        renderNearby(firstIndex);
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
      navigateToPage.current = null;
      renderPage.current = () => Promise.resolve();
      resize?.disconnect();
      flip?.destroy();
      void loadingTask?.destroy();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      root.remove();
    };
  }, [entry.url, initialPage]);

  useEffect(() => {
    if (!magnifier || loading || error) return;
    const pages = [pageIndex, orientation === "landscape" ? pageIndex + 1 : -1]
      .map((index) =>
        host.current?.querySelector<HTMLElement>(
          `.pdf-book-page[data-page="${index}"]`,
        ),
      )
      .filter((page): page is HTMLElement => !!page);
    const lenses = pages.map((page) => {
      const lens = new LensZoom(page, {
        zoom: 2.5,
        lensSize: 180,
        lensColor: "#fff",
        borderColor: "#a9a9a9",
      });
      lens.init();
      return lens;
    });
    return () => lenses.forEach((lens) => lens.cleanup());
  }, [magnifier, pageIndex, orientation, loading, error]);

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

  const end =
    orientation === "landscape" && pageIndex > 0
      ? Math.min(pageCount, pageIndex + 2)
      : pageIndex + 1;
  const pageLabel = !pageCount
    ? "?"
    : pageIndex + 1 === end
      ? end + " / " + pageCount
      : pageIndex + 1 + "?" + end + " / " + pageCount;
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
      >
        <div className="pdf-book-content">
          <div className="pdf-book-stage">
            <div
              ref={host}
              className="pdf-book-host"
              aria-label="Страницы PDF"
              aria-busy={loading}
              onMouseDownCapture={(event) => {
                if (magnifier) event.stopPropagation();
              }}
              style={{ visibility: loading || !!error ? "hidden" : "visible" }}
            />
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
            </div>
            {sidebarTab === "outline" && outline.length > 0 ? (
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
                <div className="pdf-book-comments-list">
                  {annotations.map((item) => (
                    <article
                      key={item.id}
                      className={
                        item.id === activeAnnotation ? "is-active" : ""
                      }
                    >
                      <button
                        type="button"
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
        {infoOpen && (
          <div
            className="pdf-book-info"
            role="group"
            aria-label="Сведения о документе"
          >
            <p>
              <span>Документ</span>
              {entry.title}
            </p>
            {entry.documentType && (
              <p>
                <span>Тип</span>
                {entry.documentType}
              </p>
            )}
            {entry.documentDate && (
              <p>
                <span>Дата</span>
                {entry.documentDate}
              </p>
            )}
            {entry.place && (
              <p>
                <span>Место</span>
                {entry.place}
              </p>
            )}
            {entry.provenance && (
              <p>
                <span>Источник</span>
                {entry.provenance}
              </p>
            )}
            {entry.description && (
              <p>
                <span>Описание</span>
                {entry.description}
              </p>
            )}
            {onEdit && (
              <button
                type="button"
                onClick={onEdit}
                aria-label="Редактировать сведения о документе"
              >
                Редактировать
              </button>
            )}
          </div>
        )}
        <footer
          className="pdf-book-controls"
          aria-label="Управление документом"
        >
          <button
            type="button"
            onClick={() => {
              void renderPage.current(Math.max(0, pageIndex - 1));
              book.current?.flipPrev();
            }}
            disabled={loading || !!error || pageIndex === 0}
            aria-label="Предыдущая страница"
            title="Предыдущая страница"
          >
            <ArrowLeft size={19} />
          </button>
          <span className="pdf-book-page-count" aria-live="polite">
            {pageLabel}
          </span>
          <button
            type="button"
            onClick={() => {
              void renderPage.current(pageIndex + 1);
              void renderPage.current(pageIndex + 2);
              book.current?.flipNext();
            }}
            disabled={loading || !!error || end >= pageCount}
            aria-label="Следующая страница"
            title="Следующая страница"
          >
            <ArrowRight size={19} />
          </button>
          <span className="pdf-book-control-divider" />
          <button
            type="button"
            className={magnifier ? "is-active" : ""}
            onClick={() => {
              setAnnotating(false);
              setSelection(null);
              setMagnifier((value) => !value);
            }}
            disabled={loading || !!error}
            aria-label="Лупа"
            aria-pressed={magnifier}
            title="Лупа · Escape для выхода"
          >
            <Search size={19} />
          </button>
          <button
            type="button"
            className={infoOpen ? "is-active" : ""}
            onClick={() => setInfoOpen((value) => !value)}
            aria-label="Сведения о документе"
            aria-expanded={infoOpen}
            title="Сведения о документе"
          >
            <CircleAlert size={18} />
          </button>
          <a
            href={archiveResourceUrl(entry.url)}
            download={entry.title + ".pdf"}
            aria-label="Скачать оригинал"
            title="Скачать оригинал"
          >
            <Download size={18} />
          </a>
          <button
            type="button"
            className="pdf-book-sidebar-toggle"
            onClick={() => setCommentsOpen((value) => !value)}
            aria-label="Комментарии"
            aria-expanded={commentsOpen}
            title="Комментарии"
          >
            <MessageSquare size={18} />
          </button>
          <button
            ref={closeButton}
            type="button"
            onClick={onClose}
            aria-label="Закрыть документ"
            title="Закрыть"
          >
            <X size={19} />
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
