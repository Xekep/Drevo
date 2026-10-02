import { BookReaderPlugin } from "@internetarchive/bookreader/src/BookReaderPlugin.js";
import type { ReaderCommand, ReaderEvent } from "./bookreader-frame-messages";
import type { BookReaderInstance } from "./bookreader-runtime";
import type {
  AnnotationSelection,
  DocumentAnnotation,
} from "../shared/document-annotations";

type PageContainer = {
  page?: {
    index: number;
    width: number;
    height: number;
    widthInches: number;
    heightInches: number;
  };
  $container: { 0: HTMLElement };
};

type OnePageView = HTMLElement & {
  scale: number;
  SPACING_IN: number;
  coordSpace: { worldUnitsToRenderedPixels(inches: number): number };
};

type PageLayer = {
  page: number;
  container: HTMLElement;
  overlay: HTMLElement;
  marks: HTMLElement;
  draft: HTMLElement;
  preview: AnnotationSelection | null;
};

export function makeDrevoPlugin(
  emit: (event: ReaderEvent) => void,
  options: {
    downloadUrl: string;
    downloadName: string;
    canEdit: boolean;
    fitSinglePage: boolean;
  },
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
    private fittedOnePage = false;

    init() {
      const sizeEdgeLabel = (event: MouseEvent) => {
        if (!(event.target instanceof Element)) return;
        const edge = event.target.closest<HTMLElement>("br-leaf-edges");
        const book = edge?.closest<HTMLElement>(".br-mode-2up__book");
        if (!edge || !book) return;
        // The native label lives inside the zoomed book. Keep its screen size fixed.
        const matrix = new DOMMatrixReadOnly(getComputedStyle(book).transform);
        const scale = Math.hypot(matrix.a, matrix.b);
        if (scale > 0) edge.style.setProperty("--drevo-edge-scale", String(scale));
      };
      document.addEventListener("mouseover", sizeEdgeLabel);
      document.addEventListener("mousemove", sizeEdgeLabel);
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
      const onePage = document.querySelector<OnePageView>("br-mode-1up");
      if (options.fitSinglePage && onePage && !this.fittedOnePage) {
        this.fittedOnePage = true;
        const { widthInches, heightInches } = pageContainer.page;
        // BookReader queues its first-render scale after mounting the mode.
        // Run after that task; subsequent zoom uses the native scale as usual.
        let fittedScale: number | undefined;
        const fit = () => {
          if (!onePage.isConnected) return;
          const pixels = onePage.coordSpace.worldUnitsToRenderedPixels;
          const padding = 2 * onePage.SPACING_IN;
          const bounds = onePage.getBoundingClientRect();
          const footer = document.querySelector(".BRfooter")?.getBoundingClientRect();
          const height = Math.min(
            onePage.clientHeight,
            footer?.height ? footer.top - bounds.top : onePage.clientHeight,
          );
          const scale = Math.min(
            onePage.clientWidth / pixels(widthInches + padding),
            height / pixels(heightInches + padding),
          );
          if (Number.isFinite(scale) && scale > 0) {
            onePage.scale = scale;
            fittedScale = scale;
          }
        };
        setTimeout(() => {
          fit();
          let fullscreenChanged = false;
          this.br.bind("fullscreenToggled", () => { fullscreenChanged = true; });
          this.br.bind("resize", () => {
            if (
              fullscreenChanged ||
              (fittedScale !== undefined && Math.abs(onePage.scale - fittedScale) < 1e-6)
            ) {
              fullscreenChanged = false;
              // Fullscreen also sets the native default scale after resize.
              queueMicrotask(fit);
            }
          });
        });
      }
      const container = pageContainer.$container[0];
      const overlay = document.createElement("div");
      overlay.className = "drevo-page-layer";
      const marks = document.createElement("div");
      marks.className = "drevo-page-marks";
      const draft = document.createElement("span");
      draft.className = "drevo-page-draft";
      draft.hidden = true;
      overlay.append(marks, draft);
      container.append(overlay);
      const page = pageContainer.page.index + 1;
      const layer: PageLayer = {
        page,
        container,
        overlay,
        marks,
        draft,
        preview: null,
      };
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
      const existing = new Map(
        Array.from(layer.marks.querySelectorAll<HTMLButtonElement>("button"))
          .map((mark) => [mark.dataset.annotationId, mark] as const),
      );
      const marks = this.annotations
        .filter((item) => item.page === layer.page)
        .map((item) => {
          const previous = existing.get(item.id);
          const mark = previous ?? document.createElement("button");
          existing.delete(item.id);
          mark.type = "button";
          mark.disabled = this.annotating || this.magnifier;
          mark.dataset.annotationId = item.id;
          mark.setAttribute(
            "aria-label",
            `Открыть комментарий на странице ${item.page}: ${item.text.slice(0, 120)}`,
          );
          mark.setAttribute(
            "aria-pressed",
            String(item.id === this.activeAnnotation),
          );
          if (!previous) {
            mark.addEventListener("pointerdown", (event) =>
              event.stopPropagation(),
            );
            mark.addEventListener("mousedown", (event) =>
              event.stopPropagation(),
            );
            // Native 2up navigation turns pages on mouseup, before click fires.
            mark.addEventListener("mouseup", (event) => event.stopPropagation());
            mark.addEventListener("click", (event) => {
              event.stopPropagation();
              emit({
                source: "drevo-bookreader",
                type: "annotation",
                id: item.id,
              });
            });
          }
          mark.className =
            "drevo-page-mark" +
            (item.id === this.activeAnnotation ? " is-active" : "") +
            (item.id === this.hoveredAnnotation ? " is-hovered" : "");
          this.position(mark, item);
          return mark;
        });
      for (const mark of existing.values()) mark.remove();
      let next = layer.marks.firstElementChild;
      for (const mark of marks) {
        if (mark !== next) layer.marks.insertBefore(mark, next);
        next = mark.nextElementSibling;
      }
      if (!this.annotating) layer.preview = null;
      this.renderDraft(layer);
    }

    private renderDraft(layer: PageLayer) {
      const selection = layer.preview ?? this.selection;
      layer.draft.hidden = selection?.page !== layer.page;
      if (!layer.draft.hidden && selection)
        this.position(layer.draft, selection);
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
      let start: { x: number; y: number; pointerId: number } | null = null;
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
      const selectionAt = (
        event: PointerEvent,
        anchor: { x: number; y: number },
      ): AnnotationSelection => {
        const end = position(event);
        return {
          page: layer.page,
          x: Math.min(anchor.x, end.x),
          y: Math.min(anchor.y, end.y),
          width: Math.abs(anchor.x - end.x),
          height: Math.abs(anchor.y - end.y),
          text: "",
        };
      };
      const cancel = () => {
        start = null;
        layer.preview = null;
        this.renderDraft(layer);
      };
      layer.overlay.addEventListener("pointerdown", (event) => {
        if (!this.annotating || event.button !== 0 || start) return;
        event.preventDefault();
        event.stopPropagation();
        start = { ...position(event), pointerId: event.pointerId };
        layer.preview = selectionAt(event, start);
        this.renderDraft(layer);
        layer.overlay.setPointerCapture(event.pointerId);
      });
      layer.overlay.addEventListener("mousedown", (event) => {
        if (this.annotating) event.stopPropagation();
      });
      layer.overlay.addEventListener("pointermove", (event) => {
        if (!start || event.pointerId !== start.pointerId) return;
        if (!this.annotating) return cancel();
        layer.preview = selectionAt(event, start);
        this.renderDraft(layer);
      });
      layer.overlay.addEventListener("pointerup", (event) => {
        if (!start || event.pointerId !== start.pointerId) return;
        if (!this.annotating) return cancel();
        event.preventDefault();
        event.stopPropagation();
        const selection = selectionAt(event, start);
        start = null;
        layer.preview = null;
        if (selection.width >= 0.006 && selection.height >= 0.006) {
          this.selection = selection;
          emit({ source: "drevo-bookreader", type: "selection", selection });
        }
        this.renderDraft(layer);
      });
      layer.overlay.addEventListener("pointercancel", cancel);
      layer.overlay.addEventListener("lostpointercapture", cancel);
    }
  };
}
