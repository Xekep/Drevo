import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, ArrowRight, ExternalLink, Trash2, X } from "lucide-react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { PageFlip } from "page-flip";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { ListedDocument } from "./documents-catalog";

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
  deleting = false,
  deleteError = "",
}: {
  document: ListedDocument;
  onClose: () => void;
  onDelete?: () => void;
  deleting?: boolean;
  deleteError?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const book = useRef<PageFlip | null>(null);
  const closeLatest = useRef(onClose);
  const [pageCount, setPageCount] = useState(0);
  const [pageIndex, setPageIndex] = useState(0);
  const [orientation, setOrientation] = useState<"portrait" | "landscape">(
    "landscape",
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
      })().finally(() => pending.delete(index));
      pending.set(index, task);
      return task;
    };
    const renderNearby = (index: number) => {
      for (let page = Math.max(0, index - 1); page <= index + 3; page++)
        void render(page).catch(() => {
          if (active) setError("Не удалось загрузить одну из страниц PDF");
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
          url: entry.url,
          withCredentials: entry.url.startsWith("/"),
        });
        pdf = await loadingTask.promise;
        if (!active) return;
        if (pdf.numPages < 1 || pdf.numPages > 300)
          throw new Error("Документ должен содержать от 1 до 300 страниц");
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
          item.append(image, number);
          root.append(item);
          return item;
        });
        await Promise.all([render(0), render(1), render(2)]);
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
        });
        flip.on("changeOrientation", ({ data }) => {
          if (!active) return;
          setOrientation(data);
          for (const [index, url] of urls) showPage(index, url);
          centerBook();
        });
        flip.loadFromHTML(pages);
        resize = new ResizeObserver(() => {
          if (active) {
            flip?.update();
            centerBook();
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
      resize?.disconnect();
      flip?.destroy();
      void loadingTask?.destroy();
      for (const url of urls.values()) URL.revokeObjectURL(url);
      root.remove();
    };
  }, [entry.url]);

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
        {deleteError && (
          <p className="pdf-book-delete-error" role="alert">
            {deleteError}
          </p>
        )}
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
