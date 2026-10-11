import { test, expect } from "@playwright/test";
import { readdirSync } from "node:fs";
import { randomFamily } from "../layout-fixtures";
test.use({ trace: "off" });
test("cold layout candidate concurrency in the real browser", async ({
  page,
}, info) => {
  test.skip(
    !process.env.DREVO_LAYOUT_PARALLEL_BENCHMARK ||
      info.project.name !== "desktop",
  );
  test.setTimeout(180_000);
  const bundle = readdirSync("dist/assets").find((name) =>
    /^layout\.worker-.*\.js$/.test(name),
  );
  expect(bundle).toBeTruthy();
  await page.route("**/__layout-benchmark", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><title>Layout benchmark</title>",
    }),
  );
  await page.goto("/__layout-benchmark");
  let expected = "";
  for (let repeat = 0; repeat < 3; repeat++)
    for (const parallelCandidates of repeat % 2
      ? [true, false]
      : [false, true]) {
      const result = await page.evaluate(
        async ({ people, parallelCandidates, bundle }) => {
          const started = performance.now();
          const worker = new Worker(`/assets/${bundle}`, { type: "module" });
          try {
            const geometry = await new Promise((resolve, reject) => {
              worker.onmessage = (event) => resolve(event.data);
              worker.onerror = reject;
              worker.postMessage({
                people,
                links: [],
                mode: "generations",
                reverse: false,
                parallelCandidates,
              });
            });
            const ms = performance.now() - started;
            const encoded = new TextEncoder().encode(JSON.stringify(geometry));
            const hash = await crypto.subtle.digest("SHA-256", encoded);
            return {
              ms,
              sha256: Array.from(new Uint8Array(hash), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            };
          } finally {
            worker.terminate();
          }
        },
        { people: randomFamily(5, 9), parallelCandidates, bundle },
      );
      expected ||= result.sha256;
      expect(result.sha256).toBe(expected);
      console.log(
        JSON.stringify({
          repeat,
          workers: parallelCandidates ? 2 : 1,
          ...result,
        }),
      );
    }
});
