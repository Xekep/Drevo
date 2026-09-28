import { storeDatabase } from "../src/server/store-database.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { initializeArchiveSchema } from "../src/server/schema.ts";
import { researchCatalogStore } from "../src/server/research-catalog.ts";
import { aiSettingsStore, publicAiStatus } from "../src/server/ai-settings.ts";
import {
  createWebSearchService,
  type WebSearchProvider,
  type WebSearchRequest,
  type WebSearchSource,
} from "../src/server/web-search.ts";
import {
  normalizeSearchUrl,
  searchDomain,
} from "../src/server/web-search-sources.ts";
import { yandexWebSearchProvider } from "../src/server/yandex-web-search.ts";
import { yandexResponsesClient } from "../src/server/yandex-responses.ts";

const signal = () => new AbortController().signal;
const source = (
  domain: string,
  categories = ["military", "ww2"],
): WebSearchSource => ({
  id: domain,
  name: domain,
  domain,
  categories,
  enabledForAiSearch: true,
  priority: 0,
});
const result = (url: string) => ({
  url,
  title: "Запись",
  snippet: "Фрагмент",
  snippetKind: "search_excerpt" as const,
  domain: "ignored.invalid",
});
function service(
  sources: WebSearchSource[],
  results = [result("https://pamyat-naroda.ru/heroes/1")],
) {
  const calls: WebSearchRequest[] = [],
    logs: object[] = [];
  const provider: WebSearchProvider = {
    name: "fake",
    maxDomains: 5,
    async search(request) {
      calls.push(request);
      return { results, summary: "Резюме" };
    },
  };
  return {
    calls,
    logs,
    service: createWebSearchService({
      provider,
      sources: () => sources,
      log: (e) => logs.push(e),
    }),
  };
}

test("trusted uses only enabled catalogue domains and military categories", async () => {
  const fixture = service([
    source("pamyat-naroda.ru"),
    source("obd-memorial.ru"),
    source("archives.example", ["archives"]),
    { ...source("disabled.example"), enabledForAiSearch: false },
  ]);
  const response = await fixture.service.search(
    { query: "private-person-query", categories: ["military"] },
    signal(),
  );
  assert.deepEqual(fixture.calls[0].allowedDomains, [
    "pamyat-naroda.ru",
    "obd-memorial.ru",
  ]);
  assert.equal(response.scope, "trusted");
  assert.equal(response.results[0].sourceId, "pamyat-naroda.ru");
  assert.equal(response.results[0].domain, "pamyat-naroda.ru");
  assert.ok(!JSON.stringify(fixture.logs).includes("private-person-query"));
  const global = await fixture.service.search(
    { query: "query", scope: "global" },
    signal(),
  );
  assert.equal(fixture.calls[1].allowedDomains, undefined);
  assert.equal(global.searchedDomains, undefined);
});

test("URL normalization rejects whitelist tricks, wrappers and duplicates", async () => {
  assert.equal(searchDomain("WWW.Example.com."), "example.com");
  assert.equal(searchDomain("пример.рф"), "xn--e1afmkfd.xn--p1ai");
  const urls = [
    "https://www.example.com/a?b=2&a=1#x",
    "http://example.com/a?a=1&b=2&utm_source=test",
    "https://sub.example.com/page",
    "https://example.com.evil.org/a",
    "https://example.com@evil.org/",
    "https://evil.example.com@evil.org/",
    "https://example.com/redirect?url=https://evil.org",
    "javascript:alert(1)",
    "https://example.com:8000/",
    "https://example.com/\\@evil.org",
  ];
  const fixture = service([source("example.com")], urls.map(result));
  const response = await fixture.service.search({ query: "query" }, signal());
  assert.deepEqual(
    response.results.map((r) => r.url),
    ["https://example.com/a?a=1&b=2", "https://sub.example.com/page"],
  );
  assert.equal(
    response.summary,
    undefined,
    "discard synthesis if some citations violate whitelist",
  );
  assert.equal(
    normalizeSearchUrl("https://example.com/?next=//evil.org"),
    null,
  );
});

test("explicit global search ignores leftover trusted categories and pagination", async () => {
  const fixture = service([source("example.com", ["archives"])]);
  await fixture.service.search(
    {
      query: "ГАСО Свердловской области Ф.6 Оп.13 Д.104",
      scope: "global",
      categories: ["archives"],
      sourcePage: 1,
    },
    signal(),
  );
  assert.equal(fixture.calls.length, 1);
  assert.equal(fixture.calls[0].scope, "global");
  assert.equal(fixture.calls[0].allowedDomains, undefined);
});

test("five-domain batches cover every catalogue resource only on explicit calls", async () => {
  const sources = Array.from({ length: 7 }, (_, i) => ({
    ...source(`source${i}.example`),
    priority: i,
  }));
  const fixture = service(sources, []);
  const first = await fixture.service.search({ query: "query" }, signal());
  assert.equal(fixture.calls.length, 1);
  assert.equal(first.nextSourcePage, 1);
  assert.equal(first.remainingDomains, 2);
  const second = await fixture.service.search(
    { query: "query", sourcePage: first.nextSourcePage },
    signal(),
  );
  assert.equal(second.nextSourcePage, undefined);
  assert.equal(
    new Set([...first.searchedDomains!, ...second.searchedDomains!]).size,
    7,
  );
  assert.equal(first.error, "WEB_SEARCH_NO_RESULTS");
});

test("unknown filters, client domains, invalid categories and empty trusted catalogue never invoke provider", async () => {
  const fixture = service([source("example.com")]);
  for (const extra of [
    { allowedDomains: ["evil.org"] },
    { dateFrom: "1908-01-01" },
    { language: "ru" },
    { categories: ["unlisted-private-query"] },
    { scope: "invalid" },
    { maxResults: 11 },
  ]) {
    await assert.rejects(
      fixture.service.search({ query: "query", ...extra }, signal()),
      /WEB_SEARCH_/,
    );
  }
  assert.equal(fixture.calls.length, 0);
  assert.ok(!JSON.stringify(fixture.logs).includes("unlisted-private-query"));
  const empty = service([]);
  assert.equal(
    (await empty.service.search({ query: "query" }, signal())).error,
    "WEB_SEARCH_NO_RESULTS",
  );
  assert.equal(empty.calls.length, 0);
});

test("deadline bounds even a stalled provider, cancellation propagates", async () => {
  const provider: WebSearchProvider = {
    name: "stalled",
    maxDomains: 5,
    search: () => new Promise(() => {}),
  };
  const search = createWebSearchService({
    provider,
    sources: () => [source("example.com")],
    timeoutMs: 10,
    log: () => {},
  });
  const keepAlive = delay(50);
  await assert.rejects(
    search.search({ query: "query" }, signal()),
    /WEB_SEARCH_TIMEOUT/,
  );
  await keepAlive;
  const controller = new AbortController();
  const pending = search.search({ query: "query" }, controller.signal);
  controller.abort();
  await assert.rejects(pending, /WEB_SEARCH_CANCELLED/);
});

const runtime = {
  apiKey: "test-super-secret-key",
  folderId: "folder-test",
  baseUrl: "https://ai.api.cloud.yandex.net/v1",
  modelUri: "gpt://folder-test/model",
};
const request: WebSearchRequest = {
  query: "Чепчугов 1908",
  scope: "trusted",
  allowedDomains: ["example.com"],
  maxResults: 5,
  signal: signal(),
};
const payload = {
  id: "r1",
  status: "completed",
  output: [
    {
      type: "message",
      content: [
        {
          type: "output_text",
          text: "Нужна проверка записи",
          annotations: [
            {
              type: "url_citation",
              url: "www.example.com/record",
              title: "",
              start_index: 0,
              end_index: 0,
            },
          ],
        },
      ],
    },
  ],
  usage: { input_tokens: 20, output_tokens: 10 },
};

test("Yandex sends documented filters using existing client, parses citations without invented snippets", async () => {
  const bodies: Record<string, unknown>[] = [];
  let usage = 0;
  const client = yandexResponsesClient(async (url, init) => {
    assert.equal(url, runtime.baseUrl + "/responses");
    assert.equal(
      new Headers(init?.headers).get("Authorization"),
      `Api-Key ${runtime.apiKey}`,
    );
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(payload);
  });
  const provider = yandexWebSearchProvider({
    client,
    runtime,
    onUsage: (value) => {
      usage += value.inputTokens;
    },
  });
  const response = await provider.search(request);
  assert.deepEqual(bodies[0].tools, [
    {
      type: "web_search",
      filters: { allowed_domains: ["example.com"] },
      search_context_size: "medium",
    },
  ]);
  assert.equal(response.results[0].url, "https://example.com/record");
  assert.equal(response.results[0].snippet, "");
  assert.equal(response.results[0].snippetKind, "unavailable");
  assert.equal(usage, 20);
  assert.equal(bodies[0].max_output_tokens, 6000);
  assert.equal(bodies[0].max_tool_calls, 1);
  await provider.search({ ...request, scope: "global" });
  assert.deepEqual(bodies[1].tools, [
    { type: "web_search", search_context_size: "medium" },
  ]);
  assert.ok(!JSON.stringify(response).includes(runtime.apiKey));
});

test("incomplete search is distinct from no results and retains charged tokens", async () => {
  let tokens = 0;
  const provider = yandexWebSearchProvider({
    runtime,
    client: yandexResponsesClient(async () =>
      Response.json({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [{ type: "reasoning", summary: [] }],
        usage: { input_tokens: 100, output_tokens: 2000 },
      }),
    ),
    onUsage: (usage) => {
      tokens += usage.inputTokens + usage.outputTokens;
    },
  });
  await assert.rejects(
    provider.search(request),
    /^Error: WEB_SEARCH_INCOMPLETE$/,
  );
  assert.equal(tokens, 2100);
});

test("Yandex controlled errors never leak error bodies or credentials", async () => {
  for (const [status, code] of [
    [429, "RATE_LIMITED"],
    [401, "INVALID_CREDENTIALS"],
    [403, "INVALID_CREDENTIALS"],
    [503, "UNAVAILABLE"],
    [400, "UNSUPPORTED_FILTER"],
  ] as const) {
    const provider = yandexWebSearchProvider({
      runtime,
      client: yandexResponsesClient(async () =>
        Response.json({ error: { message: runtime.apiKey } }, { status }),
      ),
    });
    await assert.rejects(
      provider.search(request),
      (error) =>
        error instanceof Error &&
        error.message === `WEB_SEARCH_${code}` &&
        !error.message.includes(runtime.apiKey),
    );
  }
  for (const data of [
    null,
    {},
    { status: "completed", output: "bad" },
    {
      status: "completed",
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "x", annotations: {} }],
        },
      ],
    },
  ]) {
    const provider = yandexWebSearchProvider({
      runtime,
      client: yandexResponsesClient(async () => Response.json(data)),
    });
    await assert.rejects(
      provider.search(request),
      /WEB_SEARCH_(MALFORMED_RESPONSE|UNAVAILABLE)/,
    );
  }
  const unavailable = yandexWebSearchProvider({
    runtime,
    client: yandexResponsesClient(async () => {
      throw new Error(runtime.apiKey);
    }),
  });
  await assert.rejects(
    unavailable.search(request),
    /^Error: WEB_SEARCH_UNAVAILABLE$/,
  );
  const echo = structuredClone(payload);
  echo.output[0].content[0].text = runtime.apiKey;
  const redacted = await yandexWebSearchProvider({
    runtime,
    client: yandexResponsesClient(async () => Response.json(echo)),
  }).search(request);
  assert.ok(!JSON.stringify(redacted).includes(runtime.apiKey));
});

test("existing catalogue is sole registry; settings persist and migrations are idempotent", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeArchiveSchema(db);
    initializeArchiveSchema(db);
    const catalog = researchCatalogStore(storeDatabase(db));
    const original = await catalog.webSearchSources();
    assert.ok(original.length > 40);
    assert.ok(original.every((s) => s.enabledForAiSearch));
    const military = original.filter((s) => s.categories.includes("military"));
    assert.ok(
      military.some(
        (s) => s.domain === "pamyat-naroda.ru" && s.categories.includes("ww2"),
      ),
    );
    assert.ok(
      military.some(
        (s) => s.domain === "gwar.mil.ru" && s.categories.includes("ww1"),
      ),
    );
    const actor = {
      id: "admin",
      name: "Администратор",
      role: "admin" as const,
      createdAt: "2026-09-28T00:00:00Z",
    };
    const group = (await catalog.list())[0];
    await catalog.createResource(
      group.id,
      {
        name: "Новый архив",
        url: "https://www.new-archive.example",
        description: "Метрические книги",
        categories: ["archives", "education"],
        priority: 100,
      },
      actor,
    );
    const added = (await catalog.webSearchSources()).find(
      (s) => s.domain === "new-archive.example",
    )!;
    assert.ok(added.enabledForAiSearch);
    assert.deepEqual(added.categories, ["archives", "education"]);
    await catalog.updateResource(
      added.id,
      { ...added, enabledForAiSearch: false },
      actor,
    );
    initializeArchiveSchema(db);
    assert.equal(
      (await catalog.webSearchSources()).find((s) => s.id === added.id)
        ?.enabledForAiSearch,
      false,
    );
    const settings = await aiSettingsStore(storeDatabase(db));
    await settings.write(
      { ...(await settings.read()), webSearchEnabled: true },
      actor,
    );
    const status = await publicAiStatus(settings);
    assert.equal(status.webSearchEnabled, true);
    assert.equal(status.webSearchDefaultScope, "trusted");
    assert.ok(!Object.hasOwn(status, "apiKey"));
  } finally {
    db.close();
  }
});
