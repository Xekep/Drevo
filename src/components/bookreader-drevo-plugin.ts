import { LensZoom } from "@jojovms/lens-zoom-core";
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

export function makeDrevoPlugin(emit: (event: ReaderEvent) => void) {
  return class DrevoPlugin extends BookReaderPlugin {
    declare br: BookReaderInstance;
    private layers = new Map<number, PageLayer[]>();
    private lenses = new Map<HTMLElement, LensZoom>();
    private annotations: DocumentAnnotation[] = [];
    private activeAnnotation = "";
    private selection: AnnotationSelection | null = null;
    private annotating = false;
    private magnifier = false;

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
      this.renderLayer(layer);
      if (this.magnifier) this.enableLens(container);
    }

    update(state: Extract<ReaderCommand, { type: "state" }>) {
      this.annotations = state.annotations;
      this.activeAnnotation = state.activeAnnotation;
      this.selection = state.selection;
      this.annotating = state.annotating;
      this.magnifier = state.magnifier;
      document.body.classList.toggle("drevo-annotating", this.annotating);
      document.body.classList.toggle("drevo-magnifying", this.magnifier);
      for (const layers of this.layers.values()) {
        for (const layer of layers) {
          this.renderLayer(layer);
          if (this.magnifier) this.enableLens(layer.container);
        }
      }
      if (!this.magnifier) {
        for (const lens of this.lenses.values()) lens.cleanup();
        this.lenses.clear();
      }
    }

    private enableLens(container: HTMLElement) {
      if (this.lenses.has(container)) return;
      const lens = new LensZoom(container, {
        zoom: 2.5,
        lensSize: 180,
        lensColor: "#fff",
        borderColor: "#a9a9a9",
      });
      lens.init();
      this.lenses.set(container, lens);
    }

    private renderLayer(layer: PageLayer) {
      const marks = this.annotations
        .filter((item) => item.page === layer.page)
        .map((item) => {
          const mark = document.createElement("span");
          mark.className =
            "drevo-page-mark" +
            (item.id === this.activeAnnotation ? " is-active" : "");
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
