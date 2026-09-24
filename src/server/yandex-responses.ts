export type ResponseFunctionCall = {
  type: "function_call";
  call_id: string;
  name: string;
  arguments: string;
};

export type ResponseItem =
  | { type: "message"; role: "user" | "assistant"; content: string }
  | { type: "function_call_output"; call_id: string; output: string };

type RawResponse = {
  id?: string;
  status?: string;
  error?: { code?: string; message?: string };
  output_text?: string;
  output?: Array<{
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    content?: Array<{ type?: string; text?: string }>;
  }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
  };
};

export class YandexResponseError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code = "") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function missingYandexConversation(error: unknown) {
  return (
    error instanceof YandexResponseError &&
    /(?:conversation|диалог)/i.test(`${error.code} ${error.message}`) &&
    (error.status === 404 ||
      /(?:not found|invalid|expired|не найден|недоступен|ист[её]к)/i.test(
        error.message,
      ))
  );
}

export function parseYandexResponse(response: RawResponse) {
  if (response.status !== "completed")
    throw new YandexResponseError(
      response.error?.message || "Yandex AI Studio не завершила ответ",
      502,
      response.error?.code,
    );
  if (!response.id) throw new Error("Yandex AI Studio не вернула response ID");
  const calls = (response.output || []).flatMap((item) =>
    item.type === "function_call" && item.call_id && item.name
      ? [
          {
            type: "function_call" as const,
            call_id: item.call_id,
            name: item.name,
            arguments: item.arguments || "{}",
          },
        ]
      : [],
  );
  const text =
    response.output_text ||
    (response.output || [])
      .filter((item) => item.type === "message")
      .flatMap((item) => item.content || [])
      .filter((part) => part.type === "output_text" || part.type === "text")
      .map((part) => part.text || "")
      .join("");
  return {
    id: response.id,
    text,
    calls,
    inputTokens:
      response.usage?.input_tokens ?? response.usage?.prompt_tokens ?? 0,
    outputTokens:
      response.usage?.output_tokens ?? response.usage?.completion_tokens ?? 0,
    cachedTokens: response.usage?.input_tokens_details?.cached_tokens ?? 0,
  };
}

export function yandexResponsesClient(fetcher: typeof fetch = fetch) {
  function headers(apiKey: string, folderId: string) {
    return {
      Authorization: `Api-Key ${apiKey}`,
      "Content-Type": "application/json",
      ...(folderId ? { "OpenAI-Project": folderId } : {}),
    };
  }

  async function request(
    baseUrl: string,
    path: string,
    method: string,
    apiKey: string,
    folderId: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const response = await fetcher(`${baseUrl}${path}`, {
      method,
      headers: headers(apiKey, folderId),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(90_000)])
        : AbortSignal.timeout(90_000),
    });
    if (!response.ok) {
      const raw = await response.text();
      let error: {
        error?: { code?: string; message?: string };
        code?: string;
        message?: string;
      };
      try {
        error = JSON.parse(raw);
      } catch {
        error = { message: raw.slice(0, 300) };
      }
      throw new YandexResponseError(
        error.error?.message ||
          error.message ||
          `Yandex AI Studio: HTTP ${response.status}`,
        response.status,
        error.error?.code || error.code,
      );
    }
    return response;
  }

  return {
    async createConversation(runtime: {
      baseUrl: string;
      apiKey: string;
      folderId: string;
    }) {
      const response = await request(
        runtime.baseUrl,
        "/conversations",
        "POST",
        runtime.apiKey,
        runtime.folderId,
        {},
      );
      const data = (await response.json()) as { id?: string };
      if (!data.id)
        throw new Error("Yandex AI Studio не вернула conversation ID");
      return data.id;
    },
    async deleteConversation(
      runtime: { baseUrl: string; apiKey: string; folderId: string },
      id: string,
    ) {
      await request(
        runtime.baseUrl,
        `/conversations/${encodeURIComponent(id)}`,
        "DELETE",
        runtime.apiKey,
        runtime.folderId,
      );
    },
    async respond(options: {
      runtime: {
        baseUrl: string;
        apiKey: string;
        folderId: string;
        modelUri: string;
      };
      conversationId: string;
      input: string | ResponseItem[];
      instructions: string;
      tools: Array<{
        type: "function";
        name: string;
        description: string;
        parameters: unknown;
      }>;
      compactThreshold: number | null;
      automaticTruncation: boolean;
      signal?: AbortSignal;
      stream?: boolean;
    }) {
      const { runtime } = options;
      const input =
        typeof options.input === "string"
          ? options.input
          : options.input.map((item) =>
              item.type === "function_call_output"
                ? item
                : item.role === "assistant"
                  ? {
                      type: "message" as const,
                      role: "assistant" as const,
                      status: "completed" as const,
                      content: [
                        { type: "output_text" as const, text: item.content },
                      ],
                    }
                  : {
                      type: "message" as const,
                      role: "user" as const,
                      content: [
                        { type: "input_text" as const, text: item.content },
                      ],
                    },
            );
      const body = {
        model: runtime.modelUri,
        conversation: options.conversationId,
        input,
        instructions: options.instructions,
        tools: options.tools,
        tool_choice: "auto",
        temperature: 0.2,
        truncation: options.automaticTruncation ? "auto" : "disabled",
        ...(options.compactThreshold === null
          ? {}
          : {
              context_management: {
                type: "compaction",
                compact_threshold: options.compactThreshold,
              },
            }),
        ...(options.stream ? { stream: true } : {}),
      };
      const response = await request(
        runtime.baseUrl,
        "/responses",
        "POST",
        runtime.apiKey,
        runtime.folderId,
        body,
        options.signal,
      );
      if (!options.stream)
        return parseYandexResponse((await response.json()) as RawResponse);
      if (!response.body)
        throw new Error("Yandex AI Studio не вернула поток ответа");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let completed: RawResponse | undefined;
      const consume = (frame: string) => {
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        if (!data || data === "[DONE]") return;
        let event: {
          type?: string;
          response?: RawResponse;
          error?: { message?: string };
        };
        try {
          event = JSON.parse(data);
        } catch {
          throw new Error("Yandex AI Studio вернула некорректный поток SSE");
        }
        if (event.type === "error" || event.type === "response.failed")
          throw new Error(
            event.error?.message ||
              event.response?.error?.message ||
              "Ошибка генерации ответа",
          );
        if (event.type === "response.completed" && event.response)
          completed = event.response;
      };
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          while (true) {
            const match = /\r?\n\r?\n/.exec(buffer);
            if (!match || match.index === undefined) break;
            consume(buffer.slice(0, match.index));
            buffer = buffer.slice(match.index + match[0].length);
          }
        }
        buffer += decoder.decode();
        if (buffer.trim()) consume(buffer);
      } finally {
        reader.releaseLock();
      }
      if (!completed)
        throw new Error(
          "Поток Yandex AI Studio завершился без response.completed",
        );
      return parseYandexResponse(completed);
    },
  };
}
