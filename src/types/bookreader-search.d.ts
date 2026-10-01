declare module "@internetarchive/bookreader/src/plugins/search/plugin.search.js" {
  import { BookReaderPlugin } from "@internetarchive/bookreader/src/BookReaderPlugin.js";
  import type { BookReaderInstance } from "../components/bookreader-runtime";
  import type { SearchResults } from "../components/bookreader-pdf-search";

  export class SearchPlugin extends BookReaderPlugin {
    br: BookReaderInstance;
    searchTerm: string | null;
    searchCancelled: boolean;
    suppressFragmentChange: boolean;
    _searchBoxesByIndex: Record<number, unknown[]>;
    searchView: {
      clearSearchFieldAndResults(dispatchEventWhenComplete?: boolean): void;
    };
    search(
      term?: string,
      options?: { goToFirstResult?: boolean; suppressFragmentChange?: boolean },
    ): Promise<void>;
    BRSearchCallback(
      results: SearchResults,
      options: { goToFirstResult: boolean },
    ): void;
    BRSearchCallbackError(results: SearchResults): void;
    removeSearchResults(suppressFragmentChange?: boolean): void;
    _cancelSearch(): void;
    cancelSearchRequest(): void;
    jumpToMatch(index: number): Promise<void>;
  }
}
