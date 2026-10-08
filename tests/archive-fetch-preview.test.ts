import assert from "node:assert/strict";
import test from "node:test";
import { archiveFetch } from "../src/data/archive-fetch.ts";

test("preview fetch rewrites string, URL and Request inputs before browser dispatch", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  const prefix = "/a/family-one/preview/vk%3A42";
  const received: Array<RequestInfo | URL> = [];
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { pathname: `${prefix}/tree`, origin: "https://drevo.example" } },
  });
  globalThis.fetch = async (input) => {
    received.push(input);
    return new Response(null, { status: 204 });
  };
  try {
    await archiveFetch("https://drevo.example/api/family");
    await archiveFetch(new URL("https://drevo.example/media/photo.png"));
    await archiveFetch(new Request("https://drevo.example/api/documents"));
    await archiveFetch(new Request("https://drevo.example/a/other-tree/api/family"));
    assert.deepEqual(received.map((input) =>
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url), [
      `${prefix}/api/family`,
      `${prefix}/media/photo.png`,
      `https://drevo.example${prefix}/api/documents`,
      `https://drevo.example${prefix}/api/unavailable`,
    ]);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
