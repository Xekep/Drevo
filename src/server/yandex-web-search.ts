import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchProviderResponse,
} from "./web-search.ts";
import { WebSearchError } from "./web-search.ts";
import { normalizeSearchUrl } from "./web-search-sources.ts";
import {
  YandexResponseError,
  yandexResponsesClient,
} from "./yandex-responses.ts";

export type WebSearchUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
};
export function yandexWebSearchProvider({
  client,
  runtime,
  onCall = () => {},
  onUsage = () => {},
}: {
  client: ReturnType<typeof yandexResponsesClient>;
  runtime: {
    baseUrl: string;
    apiKey: string;
    folderId: string;
    modelUri: string;
  };
  onCall?: () => void;
  onUsage?: (usage: WebSearchUsage) => void;
}): WebSearchProvider {
  return {
    name: "yandex",
    maxDomains: 5,
    async search(
      request: WebSearchRequest,
    ): Promise<WebSearchProviderResponse> {
      if (
        request.scope === "trusted" &&
        (!request.allowedDomains?.length || request.allowedDomains.length > 5)
      )
        throw new WebSearchError("WEB_SEARCH_INVALID_INPUT");
      try {
        onCall();
        const data = await client.webSearch({
          runtime,
          query: request.query,
          allowedDomains:
            request.scope === "trusted" ? request.allowedDomains : undefined,
          signal: request.signal,
        });
        // Only extract the documented fields. Never expose provider error bodies.
        if (!data || typeof data !== "object")
          throw new WebSearchError("WEB_SEARCH_MALFORMED_RESPONSE");
        const raw = data as Record<string, unknown>;
        // Incomplete responses are billable too; do not lose their usage.
        const usage =
          raw.usage && typeof raw.usage === "object"
            ? (raw.usage as Record<string, unknown>)
            : {};
        const count = (n: unknown) =>
          typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
        onUsage({
          inputTokens: count(usage.input_tokens),
          outputTokens: count(usage.output_tokens),
          cachedTokens: 0,
        });
        if (raw.status === "incomplete")
          throw new WebSearchError("WEB_SEARCH_INCOMPLETE");
        if (raw.status !== "completed")
          throw new WebSearchError("WEB_SEARCH_UNAVAILABLE");
        if (!Array.isArray(raw.output))
          throw new WebSearchError("WEB_SEARCH_MALFORMED_RESPONSE");
        const response: WebSearchProviderResponse = {
          results: [],
          notice:
            "Резюме сгенерировано моделью поиска и не является цитатой. API может не предоставлять заголовки и фрагменты страниц; пустой snippet означает, что фрагмент недоступен. Наличие URL не доказывает факт.",
        };
        const summaries: string[] = [];
        let invalidCitation = false;
        for (const item of raw.output) {
          if (!item || typeof item !== "object")
            throw new WebSearchError("WEB_SEARCH_MALFORMED_RESPONSE");
          if (item.type !== "message") continue;
          if (!Array.isArray(item.content))
            throw new WebSearchError("WEB_SEARCH_MALFORMED_RESPONSE");
          for (const part of item.content) {
            if (!part || typeof part !== "object")
              throw new WebSearchError("WEB_SEARCH_MALFORMED_RESPONSE");
            if (part.type !== "output_text") continue;
            if (
              typeof part.text !== "string" ||
              (part.annotations !== undefined &&
                !Array.isArray(part.annotations))
            )
              throw new WebSearchError("WEB_SEARCH_MALFORMED_RESPONSE");
            summaries.push(part.text);
            for (const citation of part.annotations || []) {
              if (!citation || citation.type !== "url_citation") continue;
              if (typeof citation.url !== "string")
                throw new WebSearchError("WEB_SEARCH_MALFORMED_RESPONSE");
              // Yandex also documents schemeless citation URLs.
              const url = normalizeSearchUrl(
                /^[a-z][a-z0-9+.-]*:/i.test(citation.url)
                  ? citation.url
                  : `https://${citation.url}`,
              );
              if (!url) {
                invalidCitation = true;
                continue;
              }
              response.results.push({
                title: typeof citation.title === "string" ? citation.title : "",
                url: url.url,
                domain: url.domain,
                snippet: "",
                snippetKind: "unavailable",
              });
            }
          }
        }
        response.summary = invalidCitation
          ? ""
          : summaries.join("\n").slice(0, 6000);
        // Defensive redaction even if a misconfigured endpoint echoes credentials.
        const safe = (value: string) =>
          runtime.apiKey
            ? value.split(runtime.apiKey).join("[redacted]")
            : value;
        response.summary = safe(response.summary);
        response.results = response.results
          .filter(
            (result) =>
              !runtime.apiKey ||
              (!result.url.includes(encodeURIComponent(runtime.apiKey)) &&
                !result.url.includes(runtime.apiKey)),
          )
          .map((result) => ({ ...result, title: safe(result.title) }));
        return response;
      } catch (error) {
        if (request.signal.aborted)
          throw new WebSearchError(
            request.signal.reason?.name === "TimeoutError"
              ? "WEB_SEARCH_TIMEOUT"
              : "WEB_SEARCH_CANCELLED",
          );
        if (error instanceof WebSearchError) throw error;
        if (error instanceof YandexResponseError)
          throw new WebSearchError(
            error.status === 429
              ? "WEB_SEARCH_RATE_LIMITED"
              : error.status === 401 || error.status === 403
                ? "WEB_SEARCH_INVALID_CREDENTIALS"
                : error.status === 400
                  ? "WEB_SEARCH_UNSUPPORTED_FILTER"
                  : "WEB_SEARCH_UNAVAILABLE",
          );
        throw new WebSearchError(
          error instanceof SyntaxError
            ? "WEB_SEARCH_MALFORMED_RESPONSE"
            : "WEB_SEARCH_UNAVAILABLE",
        );
      }
    },
  };
}
