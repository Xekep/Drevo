import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { archiveChanges } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

async function countCalculations(page: Page) {
  await page.addInitScript(() => {
    const state = { requests: 0 };
    Object.assign(window, { __layoutCalculations: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private layout: boolean;
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.layout = String(url).includes("layout.worker");
      }
      postMessage(message: unknown) {
        if (this.layout) state.requests++;
        super.postMessage(message);
      }
    };
  });
}
const calculations = (page: Page) =>
  page.evaluate(
    () =>
      (window as typeof window & { __layoutCalculations: { requests: number } })
        .__layoutCalculations.requests,
  );

test("a fresh browser reuses server layout and falls back to its Worker when cache is unavailable", async ({
  page,
  browser,
  request,
}, info) => {
  test.setTimeout(60_000);
  const original = await (await request.get("/api/family")).json();
  const family = original.family as Family;
  const prefix = `cache-${randomUUID()}`;
  const additions = Array.from({ length: 40 }, (_, i) => ({
    ...family.people[0],
    id: `${prefix}-${i}`,
    name: `Кеш ${i}`,
    birth: "",
    death: undefined,
    parents: [],
    spouses: [],
    sources: [],
    events: [],
    awards: [],
  }));
  const created = await request.post("/api/family/changes", {
    headers: { "If-Match": String(original.revision) },
    data: {
      changes: archiveChanges(family, {
        ...family,
        people: [...family.people, ...additions],
      }),
    },
  });
  expect(created.status()).toBe(200);
  const contexts = [];
  try {
    await countCalculations(page);
    const firstRequest = page.waitForRequest(
      (r) => new URL(r.url()).pathname === "/api/tree-layout",
    );
    await page.goto("/tree");
    const data = (await firstRequest).postDataJSON();
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-ready",
      "true",
    );
    await expect
      .poll(
        async () => {
          const response = await request.post("/api/tree-layout", { data });
          expect(response.status()).toBe(200);
          return Boolean((await response.json()).geometry);
        },
        { timeout: 30_000 },
      )
      .toBe(true);
    const baseURL = new URL(page.url()).origin;
    for (const offline of [false, true]) {
      const context = await browser.newContext({
        baseURL,
        viewport: page.viewportSize()!,
      });
      contexts.push(context);
      const fresh = await context.newPage();
      await countCalculations(fresh);
      await fresh.route("**/api/tree-layout", async route => {
        if (offline) return route.abort();
        // Slow mobile login must not abandon an existing server cache after 1s.
        const cached = await route.fetch();
        await new Promise(resolve => setTimeout(resolve, 1500));
        await route.fulfill({ response: cached });
      });
      const response = offline
        ? undefined
        : fresh.waitForResponse(
            (r) => new URL(r.url()).pathname === "/api/tree-layout",
          );
      const start = Date.now();
      await fresh.goto("/tree");
      await expect(fresh.locator(".tree-canvas")).toHaveAttribute(
        "data-layout-ready",
        "true",
      );
      if (response)
        expect(
          (await (await response).json()).geometry.positions.length,
        ).toBeGreaterThanOrEqual(40);
      if (offline) expect(await calculations(fresh)).toBeGreaterThan(0);
      else expect(await calculations(fresh)).toBe(0);
      await info.attach(offline ? "local-fallback" : "shared-hit", {
        body: JSON.stringify({
          elapsedMs: Date.now() - start,
          workerCalculations: await calculations(fresh),
        }),
        contentType: "application/json",
      });
    }
  } finally {
    for (const context of contexts) await context.close();
    await page.close();
    const current = await (await request.get("/api/family")).json();
    const stored = current.family as Family;
    const restored = await request.post("/api/family/changes", {
      headers: { "If-Match": String(current.revision) },
      data: {
        changes: archiveChanges(stored, {
          ...stored,
          people: stored.people.filter((p) => !p.id.startsWith(prefix)),
        }),
      },
    });
    expect(restored.status()).toBe(200);
  }
});
