import test from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithTimeout,
  RequestTimeoutError,
} from "../src/data/request-timeout.ts";

test("fetchWithTimeout returns an ordinary response before the deadline", async () => {
  const response = await fetchWithTimeout(
    "https://example.invalid/ok",
    {},
    50,
    async () => Response.json({ ok: true }),
  );
  assert.deepEqual(await response.json(), { ok: true });
});

test("fetchWithTimeout aborts a stalled request and reports a dedicated error", async () => {
  const stalled: typeof fetch = async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true },
      );
    });
  await assert.rejects(
    () => fetchWithTimeout("https://example.invalid/slow", {}, 10, stalled),
    (error: unknown) =>
      error instanceof RequestTimeoutError && error.timeoutMs === 10,
  );
});

test("fetchWithTimeout preserves non-timeout network failures", async () => {
  const broken: typeof fetch = async () => {
    throw new TypeError("network down");
  };
  await assert.rejects(
    () => fetchWithTimeout("https://example.invalid/broken", {}, 50, broken),
    /network down/,
  );
});
