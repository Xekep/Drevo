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

export async function fetchAiStudioModels({
  baseUrl,
  apiKey,
  folderId,
  fetcher = fetch,
}: {
  baseUrl: string;
  apiKey: string;
  folderId: string;
  fetcher?: typeof fetch;
}): Promise<AiStudioModel[]> {
  const response = await fetcher(`${baseUrl.replace(/\/$/, "")}/models`, {
      headers: {
        Authorization: `Api-Key ${apiKey}`,
        "x-project": folderId,
      },
      signal: AbortSignal.timeout(10_000),
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
