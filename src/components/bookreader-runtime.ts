import "@internetarchive/bookreader/BookReader/BookReader.css";
import polyfillUrl from "@internetarchive/bookreader/BookReader/webcomponents-bundle.js?url";
import jqueryUrl from "@internetarchive/bookreader/BookReader/jquery-3.js?url";

export type ReaderPage = { width: number; height: number; leafNum?: number };
export type BookReaderInstance = {
  init(): void;
  currentIndex(): number;
  jumpToIndex(index: number): void;
  bind(name: string, handler: () => void): void;
  trigger(name: string, properties?: unknown): void;
  removeProgressPopup(): void;
  mode: number;
  constModeThumb: number;
  constMode1up: number;
  constMode2up: number;
  switchMode(mode: number): void;
  resize(): void;
  _modes: {
    mode1Up: {
      mode1UpLit: HTMLElement & {
        updateVisibleRegion(): void;
        initFirstRender(index: number): void;
      };
    };
  };
  _components: {
    navbar: {
      getNavPageNumString(index: number): string;
      updateNavPageNum(index: number): void;
    };
  };
  plugins: Record<string, unknown>;
};

export type BookReaderConstructor = {
  new (options: {
    el: string;
    data: ReaderPage[][];
    ppi: number;
    defaults: string;
    ui: "full";
    showLogo: boolean;
    autoResize: boolean;
    flipSpeed: number;
    imagesBaseURL: string;
    metadata: { label: string; value: string }[];
    plugins?: { search: { enabled: boolean }; resume: { enabled: boolean } };
    getPageNum(index: number): string;
    getPageURI(index: number): string;
    renderPageURI(image: HTMLImageElement, uri: string): void;
  }): BookReaderInstance;
  registerPlugin(
    name: string,
    plugin: new (reader: BookReaderInstance) => unknown,
  ): void;
};

declare global {
  interface Window {
    BookReader?: BookReaderConstructor;
  }
}

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    // Download dependencies together, execute classic scripts in insertion order.
    script.async = false;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Не удалось загрузить BookReader"));
    document.head.append(script);
  });
}

export async function loadBookReader(): Promise<BookReaderConstructor> {
  const needsPolyfill =
    !window.customElements || !HTMLElement.prototype.attachShadow;
  await Promise.all([
    ...(needsPolyfill ? [loadScript(polyfillUrl)] : []),
    loadScript(jqueryUrl),
  ]);
  // Bundle the official modules against the patched npm dependency. The
  // precompiled BookReader.js embeds its own older copy of jQuery UI.
  const { default: BookReader } = await import("./bookreader-entry");
  return BookReader;
}
