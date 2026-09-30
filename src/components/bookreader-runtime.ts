import "@internetarchive/bookreader/BookReader/BookReader.css";
import polyfillUrl from "@internetarchive/bookreader/BookReader/webcomponents-bundle.js?url";
import jqueryUrl from "@internetarchive/bookreader/BookReader/jquery-3.js?url";
import bookReaderUrl from "@internetarchive/bookreader/BookReader/BookReader.js?url";

export type ReaderPage = { width: number; height: number };
export type BookReaderInstance = {
  init(): void;
  currentIndex(): number;
  jumpToIndex(index: number): void;
  bind(name: string, handler: () => void): void;
  mode: number;
  constModeThumb: number;
  plugins: Record<string, unknown>;
};

export type BookReaderConstructor = {
  new (options: {
    el: string;
    data: ReaderPage[][];
    defaults: string;
    ui: "full";
    showLogo: boolean;
    autoResize: boolean;
    flipSpeed: number;
    imagesBaseURL: string;
    metadata: { label: string; value: string }[];
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
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Не удалось загрузить BookReader"));
    document.head.append(script);
  });
}

export async function loadBookReader(): Promise<BookReaderConstructor> {
  await loadScript(polyfillUrl);
  await loadScript(jqueryUrl);
  await loadScript(bookReaderUrl);
  if (!window.BookReader) throw new Error("Не удалось запустить BookReader");
  return window.BookReader;
}
