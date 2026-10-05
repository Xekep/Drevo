const mediaPath = /^\/(?:a\/[A-Za-z0-9][A-Za-z0-9-]{2,63}\/)?media\/[a-zA-Z0-9-]+\.(?:jpg|png|webp)$/;

export const portraitRetryDelays = [400, 1200] as const;
// A pending img/decode has no error event on some stalled connections.
export const portraitLoadTimeoutMs = 15_000;

export function retryPortraitUrl(url: string, attempt: number) {
  if (!attempt) return url;
  const parsed = new URL(url, window.location.href);
  parsed.searchParams.set("portrait-retry", String(attempt));
  return `${parsed.pathname}${parsed.search}`;
}

/** An img error has no status. Probe only our own media route before retrying. */
export async function mayRetryPortrait(url: string, signal: AbortSignal) {
  const parsed = new URL(url, window.location.href);
  if (parsed.origin !== window.location.origin || !mediaPath.test(parsed.pathname))
    return false;
  if (signal.aborted) return false;
  const probe = new AbortController();
  const abort = () => probe.abort();
  signal.addEventListener("abort", abort, { once: true });
  const deadline = window.setTimeout(abort, 2_500);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      credentials: "same-origin",
      signal: probe.signal,
    });
    void response.body?.cancel().catch(() => {});
    return (response.ok && response.headers.get("content-type")?.startsWith("image/") === true) ||
      [409, 429, 503].includes(response.status);
  } catch {
    return false;
  } finally {
    window.clearTimeout(deadline);
    signal.removeEventListener("abort", abort);
  }
}

export function waitForPortraitRetry(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const finish = () => {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = window.setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
  });
}
