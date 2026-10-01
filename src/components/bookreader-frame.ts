import { getDocument, GlobalWorkerOptions } from "pdfjs-dist";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { documentFileTypeFromMime } from "../shared/document-file.ts";
import { makeDrevoPlugin } from "./bookreader-drevo-plugin";
import type { ReaderCommand, ReaderEvent } from "./bookreader-frame-messages";
import {
  loadBookReader,
  type BookReaderInstance,
  type ReaderPage,
} from "./bookreader-runtime";
import "./bookreader-frame.css";

GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const source = "drevo-bookreader";
const origin = window.location.origin;
const send = (event: ReaderEvent) => window.parent.postMessage(event, origin);
const escapeHtml = (value: string) =>
  value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ]!,
  );
let reader: BookReaderInstance | null = null;
let pendingState: Extract<ReaderCommand, { type: "state" }> | null = null;
let opening = false;
let pageCount = 0;
let cleanupDocument: () => void = () => {};
window.addEventListener("pagehide", () => cleanupDocument(), { once: true });

async function pageDimensions(pdf: PDFDocumentProxy): Promise<ReaderPage[]> {
  const dimensions = Array<ReaderPage>(pdf.numPages);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(6, pdf.numPages) }, async () => {
      while (next < pdf.numPages) {
        const index = next++;
        const page = await pdf.getPage(index + 1);
        const viewport = page.getViewport({ scale: 1 });
        dimensions[index] = {
          width: viewport.width,
          height: viewport.height,
        };
      }
    }),
  );
  return dimensions;
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob
          ? resolve(blob)
          : reject(new Error("Не удалось подготовить страницу PDF")),
      "image/webp",
      0.92,
    );
  });
}

async function readOutline(pdf: PDFDocumentProxy) {
  try {
    const bookmarks = await pdf.getOutline();
    if (!bookmarks?.length) return;
    const items: Extract<ReaderEvent, { type: "outline" }>["items"] = [];
    const collect = async (entries: typeof bookmarks, depth: number) => {
      for (const entry of entries) {
        const destination =
          typeof entry.dest === "string"
            ? await pdf.getDestination(entry.dest)
            : entry.dest;
        if (destination?.length) {
          const target = destination[0];
          const page =
            typeof target === "number"
              ? target
              : await pdf.getPageIndex(target);
          if (page >= 0 && page < pdf.numPages)
            items.push({ title: entry.title, page, depth });
        }
        if (entry.items?.length) await collect(entry.items, depth + 1);
      }
    };
    await collect(bookmarks, 0);
    if (items.length) send({ source, type: "outline", items });
  } catch {
    // A damaged outline must not prevent a valid document from opening.
  }
}

async function prepareDocument(
  command: Extract<ReaderCommand, { type: "init" }>,
) {
  let dimensions: ReaderPage[];
  let render: (index: number) => Promise<string>;
  let prefetch: (index: number) => void = () => {};
  let readBookmarks: () => void = () => {};
  if (command.mimeType === "application/pdf") {
    const loadingTask = getDocument({
      url: command.url,
      withCredentials: command.url.startsWith("/"),
      disableStream: true,
      disableAutoFetch: true,
    });
    cleanupDocument = () => {
      void loadingTask.destroy();
    };
    const pdf = await loadingTask.promise;
    if (pdf.numPages < 1 || pdf.numPages > 2000)
      throw new Error("Документ должен содержать от 1 до 2000 страниц");
    pageCount = pdf.numPages;
    const urls = new Map<number, string>();
    const pending = new Map<number, Promise<string>>();
    let disposed = false;
    let activeRenders = 0;
    const waiting: (() => void)[] = [];
    const nextRender = () => {
      while (activeRenders < 2 && waiting.length) {
        activeRenders++;
        waiting.shift()!();
      }
    };
    render = (index: number): Promise<string> => {
      const url = urls.get(index);
      if (url) return Promise.resolve(url);
      const inProgress = pending.get(index);
      if (inProgress) return inProgress;
      const task = (async () => {
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          nextRender();
        });
        if (disposed) throw new Error("Документ закрыт");
        const page = await pdf.getPage(index + 1);
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
        if (!context) throw new Error("Не удалось отобразить страницу PDF");
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        const blob = await canvasBlob(canvas);
        page.cleanup();
        if (disposed) throw new Error("Документ закрыт");
        const result = URL.createObjectURL(blob);
        urls.set(index, result);
        return result;
      })().finally(() => {
        pending.delete(index);
        activeRenders--;
        nextRender();
      });
      pending.set(index, task);
      return task;
    };
    cleanupDocument = () => {
      if (disposed) return;
      disposed = true;
      for (const url of urls.values()) URL.revokeObjectURL(url);
      void loadingTask.destroy();
    };
    // Keep exact sizes for mixed-format PDFs; render the opening spread in parallel.
    const initial = Math.min(
      pageCount - 1,
      Math.max(0, command.initialPage - 1),
    );
    const spread =
      initial === 0
        ? [0]
        : initial % 2
          ? [initial, initial + 1]
          : [initial - 1, initial];
    [dimensions] = await Promise.all([
      pageDimensions(pdf),
      Promise.all(spread.filter((index) => index < pageCount).map(render)),
    ]);
    prefetch = (index: number) => {
      for (const page of [index, index + 1, index + 2, index + 3, index + 4]) {
        if (page >= 0 && page < pageCount)
          void render(page).catch((error) => {
            send({ source, type: "error", message: String(error) });
          });
      }
    };
    readBookmarks = () => {
      void readOutline(pdf);
    };
  } else {
    const type = documentFileTypeFromMime(command.mimeType);
    if (!type || type.extension === "pdf")
      throw new Error("Тип документа не поддерживается");
    const image = new Image();
    image.src = command.url;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight)
      throw new Error("Изображение документа повреждено");
    pageCount = 1;
    dimensions = [{ width: image.naturalWidth, height: image.naturalHeight }];
    render = () => Promise.resolve(command.url);
  }
  return { dimensions, render, prefetch, readBookmarks };
}

async function open(command: Extract<ReaderCommand, { type: "init" }>) {
  if (opening) return;
  opening = true;
  try {
    const [BookReader, { dimensions, render, prefetch, readBookmarks }] =
      await Promise.all([loadBookReader(), prepareDocument(command)]);
    const data: ReaderPage[][] = [[dimensions[0]]];
    for (let index = 1; index < dimensions.length; index += 2)
      data.push(dimensions.slice(index, index + 2));
    BookReader.registerPlugin(
      "drevo",
      makeDrevoPlugin(send, {
        downloadUrl: command.url,
        downloadName: command.downloadName,
        canEdit: command.canEdit,
      }),
    );
    const initial = Math.min(
      pageCount - 1,
      Math.max(0, command.initialPage - 1),
    );
    reader = new BookReader({
      el: "#bookreader",
      data,
      // BookReader assumes 500 ppi scans. Our PDFs use points and small scans
      // may have fewer pixels; 144 keeps them legible on the initial view.
      ppi: 144,
      defaults: `page/n${initial}/mode/2up`,
      ui: "full",
      showLogo: false,
      autoResize: true,
      flipSpeed: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? 1
        : 550,
      imagesBaseURL: "/bookreader/images/",
      metadata: [
        { label: "Название", value: command.title },
        ...command.metadata,
      ].map(({ label, value }) => ({ label, value: escapeHtml(value) })),
      getPageNum(index) {
        return String(Math.min(pageCount - 1, Math.max(0, index)) + 1);
      },
      getPageURI(index) {
        return `drevo-page:${index}`;
      },
      renderPageURI(image, uri) {
        image.draggable = false;
        const index = Number(uri.slice("drevo-page:".length));
        if (!Number.isInteger(index) || index < 0 || index >= pageCount) return;
        void render(index)
          .then((url) => {
            image.src = url;
          })
          .catch((error) => {
            send({ source, type: "error", message: String(error) });
          });
      },
    });
    reader.init();
    reader.bind("pageChanged", () => {
      if (!reader) return;
      const page = reader.currentIndex();
      send({ source, type: "page", page });
      prefetch(page);
    });
    if (pendingState) {
      (
        reader.plugins.drevo as ReturnType<typeof makeDrevoPlugin>["prototype"]
      ).update(pendingState);
    }
    prefetch(initial);
    send({ source, type: "loaded", pageCount });
    send({ source, type: "page", page: reader.currentIndex() });
    readBookmarks();
  } catch (error) {
    cleanupDocument();
    send({
      source,
      type: "error",
      message:
        error instanceof Error ? error.message : "Не удалось открыть документ",
    });
  }
}

window.addEventListener("message", (event: MessageEvent<ReaderCommand>) => {
  if (event.origin !== origin || event.source !== window.parent) return;
  const command = event.data;
  if (command?.source !== source) return;
  if (command.type === "init") void open(command);
  if (command.type === "state") {
    pendingState = command;
    if (reader)
      (
        reader.plugins.drevo as ReturnType<typeof makeDrevoPlugin>["prototype"]
      ).update(command);
  }
  if (command.type === "jump" && reader)
    reader.jumpToIndex(Math.min(pageCount - 1, Math.max(0, command.page)));
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  const nativeDialog = document.querySelector<HTMLElement>("#colorbox");
  if (nativeDialog && getComputedStyle(nativeDialog).display !== "none") return;
  if (pendingState?.magnifier) {
    event.preventDefault();
    send({ source, type: "magnifier-off" });
  } else send({ source, type: "close" });
});

window.addEventListener(
  "contextmenu",
  (event) => {
    const onPage =
      event.target instanceof Element &&
      event.target.closest(".BRpagecontainer");
    if (onPage || pendingState?.magnifier) event.preventDefault();
    if (pendingState?.magnifier) send({ source, type: "magnifier-off" });
  },
  { capture: true },
);

send({ source, type: "ready" });
