import { fetchAiStudioModels } from "./ai-models.ts";
import type { aiRuntimeConfig } from "./ai-settings.ts";
import {
  estimateTokens,
  usageTokens,
  type ModelResponse,
} from "./ai-research-support.ts";

export function aiVision(fetcher: typeof fetch) {
  let visionModelCache:
    { key: string; modelUri: string; expiresAt: number } | undefined;
  function providerHeaders(
    runtime: Awaited<ReturnType<typeof aiRuntimeConfig>>,
  ) {
    return {
      Authorization: `Api-Key ${runtime.apiKey}`,
      "Content-Type": "application/json",
      ...(runtime.folderId ? { "OpenAI-Project": runtime.folderId } : {}),
    };
  }

  async function visionModelUri(
    runtime: Awaited<ReturnType<typeof aiRuntimeConfig>>,
  ) {
    const folderId =
        runtime.folderId ||
        /^gpt:\/\/([^/]+)/.exec(runtime.modelUri)?.[1] ||
        "",
      key = `${runtime.baseUrl}\0${folderId}`;
    if (
      visionModelCache?.key === key &&
      visionModelCache.expiresAt > Date.now()
    )
      return visionModelCache.modelUri;
    const current = runtime.modelUri.replace(/^gpt:\/\/[^/]+\//, "");
    if (/^qwen3\.6-35b-a3b(?:\/latest)?$/.test(current))
      return runtime.modelUri;
    const models = await fetchAiStudioModels({
        baseUrl: runtime.baseUrl,
        apiKey: runtime.apiKey,
        folderId,
        fetcher,
      }),
      selected = models.find((model) => model.label === "qwen3.6-35b-a3b");
    if (!selected)
      throw new Error(
        "В этом Folder ID нет модели Qwen3.6-35B для анализа фотографий",
      );
    visionModelCache = {
      key,
      modelUri: selected.id,
      expiresAt: Date.now() + 5 * 60_000,
    };
    return selected.id;
  }

  async function analyzeImage(
    question: string,
    dataUrl: string,
    runtime: Awaited<ReturnType<typeof aiRuntimeConfig>>,
    modelUri: string,
    signal: AbortSignal,
  ) {
    const body = {
        model: modelUri,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: question },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        temperature: 0.2,
      },
      response = await fetcher(`${runtime.baseUrl}/chat/completions`, {
        method: "POST",
        headers: providerHeaders(runtime),
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
      }),
      data = (await response.json()) as ModelResponse;
    if (!response.ok)
      throw new Error(
        data.error?.message ||
          `Модель анализа фотографий вернула HTTP ${response.status}`,
      );
    const message = data.choices?.[0]?.message,
      content =
        typeof message?.content === "string" ? message.content.trim() : "";
    if (!content)
      throw new Error("Модель анализа фотографий не вернула описание");
    const reported = usageTokens(data.usage);
    return {
      content,
      inputTokens: reported.input ?? estimateTokens(body),
      outputTokens: reported.output ?? estimateTokens(message),
    };
  }

  return { modelUri: visionModelUri, analyze: analyzeImage };
}
