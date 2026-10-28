import type { aiRuntimeConfig } from "./ai-settings.ts";
import {
  estimateTokens,
  usageTokens,
  type ModelResponse,
} from "./ai-research-support.ts";

export function aiVision(fetcher: typeof fetch) {
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
      "";
    if (runtime.visionModel)
      return runtime.visionModel.startsWith("gpt://")
        ? runtime.visionModel
        : `gpt://${folderId}/${runtime.visionModel}`;
    // The catalog exposes IDs, not image capabilities. Inherit the role's
    // configured model rather than guessing a different model by its name.
    return runtime.modelUri;
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
    if (!response.ok && [400, 415, 422].includes(response.status))
      throw new Error(
        `Выбранная модель не приняла изображение (HTTP ${response.status}). Проверьте поддержку изображений или выберите другую модель анализа фотографий в настройках роли.`,
      );
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
      usageConfirmed: reported.input !== undefined && reported.output !== undefined,
      inputTokens: reported.input ?? estimateTokens(body),
      outputTokens: reported.output ?? estimateTokens(message),
    };
  }

  return { modelUri: visionModelUri, analyze: analyzeImage };
}
