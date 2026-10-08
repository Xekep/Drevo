import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mayRetryPortrait,
  retryPortraitUrl,
} from "../src/components/portrait-retry.ts";

test("portrait retry probes the selected participant route and never substitutes owner media", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  const requested: string[] = [];
  const prefix = "/a/example-archive/preview/member%3Atest";
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: `https://drevo.invalid${prefix}/tree`,
        origin: "https://drevo.invalid",
      },
      setTimeout,
      clearTimeout,
    },
  });
  globalThis.fetch = async (input) => {
    requested.push(String(input));
    return new Response(null, { headers: { "Content-Type": "image/png" } });
  };
  try {
    const url = `${prefix}/media/portrait.png`;
    assert.equal(
      await mayRetryPortrait(url, new AbortController().signal),
      true,
    );
    assert.deepEqual(requested, [url]);
    assert.equal(retryPortraitUrl(url, 1), `${url}?portrait-retry=1`);
    assert.equal(
      await mayRetryPortrait(
        "https://external.invalid/media/portrait.png",
        new AbortController().signal,
      ),
      false,
    );
    assert.equal(
      await mayRetryPortrait(
        "/preview/%2E%2E/media/portrait.png",
        new AbortController().signal,
      ),
      false,
    );
    assert.deepEqual(
      requested,
      [url],
      "invalid or external routes must not fall back to the owner",
    );
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow)
      Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
