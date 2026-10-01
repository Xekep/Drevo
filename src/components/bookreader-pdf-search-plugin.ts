import { SearchPlugin } from "@internetarchive/bookreader/src/plugins/search/plugin.search.js";
import type { PdfTextSearch, SearchResults } from "./bookreader-pdf-search";

/** Keep BookReader's search UI/navigation; replace its IA HTTP source with PDF.js text. */
export function makePdfSearchPlugin(text: PdfTextSearch) {
  return class PdfSearchPlugin extends SearchPlugin {
    private request: AbortController | null = null;
    private hasText = true;
    private activeMatch = -1;

    private highlightActiveMatch() {
      document.querySelectorAll(".searchHiliteLayer rect").forEach((box) => {
        box.classList.toggle(
          "is-current-match",
          box.classList.contains(`match-index-${this.activeMatch}`),
        );
      });
    }

    _configurePageContainer(container: unknown) {
      super._configurePageContainer(container);
      this.highlightActiveMatch();
    }

    async jumpToMatch(index: number) {
      this.activeMatch = index;
      this.highlightActiveMatch();
      await super.jumpToMatch(index);
      this.highlightActiveMatch();
    }

    init() {
      super.init();
      const input = document.querySelector<HTMLInputElement>(".BRsearchInput")!;
      input.placeholder = "Поиск в документе";
      input.setAttribute("aria-label", "Поиск в документе");
      const form = input.closest("form")!;
      form.setAttribute("role", "search");
      form.querySelector("button")?.setAttribute("aria-label", "Найти");
      input.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (document.body.classList.contains("drevo-magnifying")) return;
        event.preventDefault();
        event.stopPropagation();
        this.cancelSearchRequest();
        this.searchView.clearSearchFieldAndResults();
      });
      input.addEventListener("search", () => {
        if (input.value) return;
        this.cancelSearchRequest();
        this.searchView.clearSearchFieldAndResults();
      });
      document.addEventListener("keydown", (event) => {
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "f"
        ) {
          event.preventDefault();
          input.focus();
          input.select();
        }
      });
      const message = (value: string) => {
        const popup = document.querySelector(".BRprogresspopup");
        if (popup) {
          // Preserve the native cancel button while translating its status message.
          const status = popup.querySelector(
            "p, :scope > div:not(.BRprogressbar)",
          );
          if (status) status.textContent = value;
          else if (popup.classList.contains("search_modal"))
            popup.textContent = value;
          popup
            .querySelector(".close-popup")
            ?.setAttribute("aria-label", "Отменить поиск");
        }
      };
      this.br.bind("SearchStarted", () => message("Поиск по тексту PDF…"));
      this.br.bind("SearchCallbackEmpty", () =>
        message(
          this.hasText
            ? "Совпадений не найдено."
            : "В PDF нет текстового слоя.",
        ),
      );
      this.br.bind("SearchCallbackError", () =>
        message("Не удалось прочитать текст PDF."),
      );
      this.br.bind("SearchCallback", () => {
        const navigation = document.querySelector(".BRsearch-navigation");
        navigation
          ?.querySelector(".prev")
          ?.setAttribute("aria-label", "Предыдущее совпадение");
        navigation
          ?.querySelector(".next")
          ?.setAttribute("aria-label", "Следующее совпадение");
        navigation
          ?.querySelector(".clear")
          ?.setAttribute("aria-label", "Очистить поиск");
      });
      const localizeCount = () => {
        const count = document.querySelector('[data-id="resultsCount"]');
        if (count?.textContent?.includes("result"))
          count.textContent = `Найдено: ${count.textContent.match(/\d+/)?.[0] ?? 0}`;
      };
      this.br.bind("SearchCallback", localizeCount);
      this.br.bind("pageChanged", localizeCount);
    }

    async search(
      term = "",
      overrides: {
        goToFirstResult?: boolean;
        suppressFragmentChange?: boolean;
      } = {},
    ) {
      this.request?.abort();
      const request = new AbortController();
      this.request = request;
      this.removeSearchResults(true);
      this.searchCancelled = false;
      this.searchTerm = term.trim();
      this.suppressFragmentChange = overrides.suppressFragmentChange ?? false;
      if (!this.suppressFragmentChange) this.br.trigger("fragmentChange");
      this.br.trigger("SearchStarted", {
        term: this.searchTerm,
        instance: this.br,
      });
      try {
        const results = await text.search(this.searchTerm, request.signal);
        if (request.signal.aborted) return;
        this.hasText = results.hasText;
        if (results.matches.length)
          this.BRSearchCallback(results, {
            goToFirstResult: overrides.goToFirstResult ?? true,
          });
        else this.BRSearchCallbackError(results);
      } catch (error) {
        if (request.signal.aborted) return;
        const results: SearchResults = {
          q: this.searchTerm,
          indexed: true,
          matches: [],
          hasText: false,
          error: error instanceof Error ? error.message : String(error),
        };
        this.BRSearchCallbackError(results);
      }
    }

    removeSearchResults(suppressFragmentChange = false) {
      this.activeMatch = -1;
      super.removeSearchResults(suppressFragmentChange);
      // The native method clears mounted highlights; also forget boxes for newly rendered pages.
      this._searchBoxesByIndex = {};
    }

    _cancelSearch() {
      this.request?.abort();
      super._cancelSearch();
    }

    cancelSearchRequest() {
      this._cancelSearch();
      this.br.removeProgressPopup();
      this.br.trigger("SearchCanceled", {
        term: this.searchTerm,
        instance: this.br,
      });
    }
  };
}
