import { createHash } from "node:crypto";

export type AiStudioModel = {
  id: string;
  label: string;
  owner: string;
};

type ModelsResponse = {
  data?: Array<{
    id?: unknown;
    owned_by?: unknown;
  }>;
  error?: { message?: unknown };
};

function modelLabel(id: string) {
  const path = /^gpt:\/\/[^/]+\/(.+)$/.exec(id)?.[1] || id;
  return path.replace(/\/latest$/, "");
}

const catalogCaches = new WeakMap<typeof fetch, Map<string, {
  expires: number;
  request: Promise<AiStudioModel[]>;
}>>();
const CATALOG_TTL = 5 * 60_000;
const MAX_CACHED_CATALOGS = 8;

/** Each catalog belongs to the provider, credential and folder used to read it. */
export async function fetchAiStudioModels({
  baseUrl,
  apiKey,
  folderId,
  fetcher = fetch,
  forceRefresh = false,
}: {
  baseUrl: string;
  apiKey: string;
  folderId: string;
  fetcher?: typeof fetch;
  forceRefresh?: boolean;
}): Promise<AiStudioModel[]> {
  const base = baseUrl.replace(/\/$/, "");
  const key = createHash("sha256").update(JSON.stringify([base, apiKey, folderId])).digest("hex");
  let cache = catalogCaches.get(fetcher);
  if (!cache) {
    cache = new Map();
    catalogCaches.set(fetcher, cache);
  }
  const existing = cache.get(key);
  if (existing && existing.expires > Date.now() && !forceRefresh)
    return (await existing.request).map((model) => ({ ...model }));
  const request = readModels(base, apiKey, folderId, fetcher);
  const entry = { expires: Date.now() + CATALOG_TTL, request };
  cache.delete(key);
  cache.set(key, entry);
  while (cache.size > MAX_CACHED_CATALOGS) cache.delete(cache.keys().next().value!);
  try {
    const result = await request;
    entry.expires = Date.now() + CATALOG_TTL;
    return result.map((model) => ({ ...model }));
  } catch (error) {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  }
}

async function readModels(baseUrl: string, apiKey: string, folderId: string, fetcher: typeof fetch) {
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "OpenAI-Project": folderId,
      },
      // The live catalog can take over ten seconds even when it returns 200.
      signal: AbortSignal.timeout(30_000),
    }),
    data = (await response.json()) as ModelsResponse;

  if (!response.ok)
    throw new Error(
      typeof data.error?.message === "string"
        ? data.error.message
        : `AI Studio вернула HTTP ${response.status}`,
    );
  if (!Array.isArray(data.data))
    throw new Error("AI Studio вернула некорректный список моделей");

  const models = new Map<string, AiStudioModel>();
  for (const item of data.data) {
    if (typeof item.id !== "string" || !item.id.startsWith("gpt://")) continue;
    models.set(item.id, {
      id: item.id,
      label: modelLabel(item.id),
      owner: typeof item.owned_by === "string" ? item.owned_by : "",
    });
  }
  return [...models.values()].sort((left, right) =>
    left.label.localeCompare(right.label, "ru"),
  );
}
