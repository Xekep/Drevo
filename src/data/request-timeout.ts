export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;

  constructor(timeoutMs: number) {
    super(`Request timed out after ${timeoutMs} ms`);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 45000,
  fetcher: typeof fetch = fetch,
) {
  const controller = new AbortController();
  const signal = init.signal
    ? AbortSignal.any([init.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (timeoutMs > 1000)
    (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const response = await fetcher(input, { ...init, signal });
    if (!response.body) {
      clearTimeout(timer);
      return response;
    }
    const reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(stream) {
        try {
          const chunk = await reader.read();
          if (chunk.done) {
            clearTimeout(timer);
            stream.close();
          } else stream.enqueue(chunk.value);
        } catch (error) {
          clearTimeout(timer);
          stream.error(
            controller.signal.aborted
              ? new RequestTimeoutError(timeoutMs)
              : error,
          );
        }
      },
      async cancel(reason) {
        clearTimeout(timer);
        await reader.cancel(reason);
      },
    });
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    if (controller.signal.aborted) throw new RequestTimeoutError(timeoutMs);
    clearTimeout(timer);
    throw error;
  }
}
