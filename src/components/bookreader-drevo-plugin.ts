import { BookReaderPlugin } from "@internetarchive/bookreader/src/BookReaderPlugin.js";
import type { ReaderCommand, ReaderEvent } from "./bookreader-frame-messages";
import type { BookReaderInstance } from "./bookreader-runtime";
import type {
  AnnotationSelection,
  DocumentAnnotation,
} from "../shared/document-annotations";

type PageContainer = {
  page?: { index: number; width: number; height: number };
  $container: { 0: HTMLElement };
};

type PageLayer = {
  page: number;
  container: HTMLElement;
  overlay: HTMLElement;
  marks: HTMLElement;
};

export function makeDrevoPlugin(
  emit: (event: ReaderEvent) => void,
  options: { downloadUrl: string; downloadName: string; canEdit: boolean },
) {
  return class DrevoPlugin extends BookReaderPlugin {
    declare br: BookReaderInstance;
    private layers = new Map<number, PageLayer[]>();
    private lens: HTMLDivElement | null = null;
    private lensButton: HTMLButtonElement | null = null;
    private commentsButton: HTMLButtonElement | null = null;
    private annotations: DocumentAnnotation[] = [];
    private activeAnnotation = "";
    private hoveredAnnotation = "";
    private selection: AnnotationSelection | null = null;
    private annotating = false;
    private magnifier = false;

    init() {
      const closeInfo = document.querySelector<HTMLButtonElement>(
        ".BRinfo .floatShut",
      );
      if (!closeInfo) return;
      // BookReader's inline onclick is blocked by Drevo's production CSP.
      closeInfo.removeAttribute("onclick");
      closeInfo.removeAttribute("href");
      closeInfo.type = "button";
      closeInfo.setAttribute("aria-label", "Закрыть сведения");
      closeInfo.addEventListener("click", () => {
        const jquery = (
          window as Window & {
            $?: { fn?: { colorbox?: { close?: () => void } } };
          }
        ).$;
        jquery?.fn?.colorbox?.close?.();
      });
    }

    _configureToolbar($toolbar: { 0: HTMLElement }) {
      const section = $toolbar[0].querySelector(".BRtoolbarSectionInfo");
      if (!section) return;
      // The stock Share dialog links to this iframe rather than to the document.
      section.querySelector(".share")?.remove();
      const button = (
        name: string,
        icon: string,
        action: () => void,
        className = "",
      ) => {
        const element = document.createElement("button");
        element.type = "button";
        element.className = `BRpill drevo-toolbar-action ${className}`;
        element.setAttribute("aria-label", name);
        element.title = name;
        element.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icon}" /></svg>`;
        element.addEventListener("click", action);
        section.append(element);
        return element;
      };
      this.lensButton = button(
        "Лупа",
        "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16m10 2-4.35-4.35",
        () => emit({ source: "drevo-bookreader", type: "toggle-magnifier" }),
      );
      const download = document.createElement("a");
      download.className = "BRpill drevo-toolbar-action";
      download.href = options.downloadUrl;
      download.download = options.downloadName;
      download.setAttribute("aria-label", "Скачать оригинал");
      download.title = "Скачать оригинал";
      download.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-5-5 5 5 5-5M4 17v3h16v-3" /></svg>';
      section.append(download);
      this.commentsButton = button(
        "Комментарии",
        "M20 11.5a8.5 8.5 0 0 1-8.5 8.5 9 9 0 0 1-3.6-.8L3 21l1.8-4.9a8.5 8.5 0 1 1 15.2-4.6Z",
        () => emit({ source: "drevo-bookreader", type: "toggle-comments" }),
        "drevo-toolbar-comments",
      );
      if (options.canEdit)
        button(
          "Редактировать сведения",
          "M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4L16.5 3.5Z",
          () => emit({ source: "drevo-bookreader", type: "edit" }),
        );
      button(
        "Закрыть документ",
        "M18 6 6 18M6 6l12 12",
        () => emit({ source: "drevo-bookreader", type: "close" }),
      );
    }

    _configurePageContainer(pageContainer: PageContainer) {
      if (!pageContainer.page || this.br.mode === this.br.constModeThumb) return;
      const container = pageContainer.$container[0];
      const overlay = document.createElement("div");
      overlay.className = "drevo-page-layer";
      const marks = document.createElement("div");
      marks.className = "drevo-page-marks";
      overlay.append(marks);
      container.append(overlay);
      const page = pageContainer.page.index + 1;
      const layer = { page, container, overlay, marks };
      const list = this.layers.get(page) ?? [];
      list.push(layer);
      this.layers.set(page, list);
      this.bindSelection(layer);
      this.bindLens(container);
      this.renderLayer(layer);
    }

    update(state: Extract<ReaderCommand, { type: "state" }>) {
      this.annotations = state.annotations;
      this.activeAnnotation = state.activeAnnotation;
      this.hoveredAnnotation = state.hoveredAnnotation;
      this.selection = state.selection;
      this.annotating = state.annotating;
      this.magnifier = state.magnifier;
      this.lensButton?.setAttribute("aria-pressed", String(this.magnifier));
      this.commentsButton?.setAttribute("aria-expanded", String(state.commentsOpen));
      document.body.classList.toggle("drevo-annotating", this.annotating);
      document.body.classList.toggle("drevo-magnifying", this.magnifier);
      for (const layers of this.layers.values()) {
        for (const layer of layers) {
          this.renderLayer(layer);
        }
      }
      if (!this.magnifier) this.hideLens();
    }

    private bindLens(container: HTMLElement) {
      container.addEventListener("pointermove", (event) => {
        if (!this.magnifier || this.annotating) return;
        const image = container.querySelector<HTMLImageElement>("img.BRpageimage");
        if (!image?.complete || !image.naturalWidth) return;
        const bounds = image.getBoundingClientRect();
        const zoom = 2.5;
        const radius = 90;
        if (!this.lens) {
          this.lens = document.createElement("div");
          this.lens.className = "drevo-magnifier-lens";
          document.body.append(this.lens);
        }
        this.lens.style.left = `${event.clientX - radius}px`;
        this.lens.style.top = `${event.clientY - radius}px`;
        this.lens.style.backgroundImage = `url("${image.currentSrc || image.src}")`;
        this.lens.style.backgroundSize = `${bounds.width * zoom}px ${bounds.height * zoom}px`;
        this.lens.style.backgroundPosition = `${radius - (event.clientX - bounds.left) * zoom}px ${radius - (event.clientY - bounds.top) * zoom}px`;
      });
      container.addEventListener("pointerleave", () => this.hideLens());
    }

    private hideLens() {
      this.lens?.remove();
      this.lens = null;
    }

    private renderLayer(layer: PageLayer) {
      const marks = this.annotations
        .filter((item) => item.page === layer.page)
        .map((item) => {
          const mark = document.createElement("span");
          mark.className =
            "drevo-page-mark" +
            (item.id === this.activeAnnotation ? " is-active" : "") +
            (item.id === this.hoveredAnnotation ? " is-hovered" : "");
          this.position(mark, item);
          return mark;
        });
      if (this.selection?.page === layer.page) {
        const draft = document.createElement("span");
        draft.className = "drevo-page-draft";
        this.position(draft, this.selection);
        marks.push(draft);
      }
      layer.marks.replaceChildren(...marks);
    }

    private position(
      element: HTMLElement,
      rect: Pick<AnnotationSelection, "x" | "y" | "width" | "height">,
    ) {
      element.style.left = `${rect.x * 100}%`;
      element.style.top = `${rect.y * 100}%`;
      element.style.width = `${rect.width * 100}%`;
      element.style.height = `${rect.height * 100}%`;
    }

    private bindSelection(layer: PageLayer) {
      let start: { x: number; y: number } | null = null;
      const position = (event: PointerEvent) => {
        const bounds = layer.overlay.getBoundingClientRect();
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
      layer.overlay.addEventListener("pointerdown", (event) => {
        if (!this.annotating || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        start = position(event);
        layer.overlay.setPointerCapture(event.pointerId);
      });
      layer.overlay.addEventListener("mousedown", (event) => {
        if (this.annotating) event.stopPropagation();
      });
      layer.overlay.addEventListener("pointerup", (event) => {
        if (!start) return;
        event.preventDefault();
        event.stopPropagation();
        const end = position(event);
        const selection: AnnotationSelection = {
          page: layer.page,
          x: Math.min(start.x, end.x),
          y: Math.min(start.y, end.y),
          width: Math.abs(start.x - end.x),
          height: Math.abs(start.y - end.y),
          text: "",
        };
        start = null;
        if (selection.width >= 0.006 && selection.height >= 0.006)
          emit({ source: "drevo-bookreader", type: "selection", selection });
      });
      layer.overlay.addEventListener("pointercancel", () => {
        start = null;
      });
    }
  };
}
