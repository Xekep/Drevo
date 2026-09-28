export type WebSearchScope = "trusted" | "global";

export type ResearchSearchSettings = {
  domain: string;
  enabledForAiSearch: boolean;
  categories: string[];
  priority: number;
};

export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
  snippetKind: "search_excerpt" | "generated_summary" | "unavailable";
  domain: string;
  sourceId?: string;
  sourceName?: string;
  rank?: number;
};

export type WebSearchResponse = {
  query: string;
  scope: WebSearchScope;
  searchedDomains?: string[];
  results: WebSearchResult[];
  summary?: string;
  nextSourcePage?: number;
  remainingDomains?: number;
  notice?: string;
  error?: string;
};
