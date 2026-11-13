import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { archiveChanges } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";
import { familyViewAction } from "./tree-toolbar-actions.ts";

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

for (const large of [false, true]) test(`a blood projection cache miss never inherits slots from the full tree (${large ? "large" : "small"})`, async ({ page }) => {
  await page.route("**/api/tree-layout", route => route.fulfill({ status: 503, json: { error: "offline" } }));
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), data = await response.json();
    const sample = data.family.people[0];
    data.family.people.push({ ...sample, id: "projection-unrelated", parents: [], spouses: [] });
    if (large) data.family.people.push(...Array.from({ length: 205 }, (_, index) => ({
      ...sample, id: `projection-descendant-${index}`, birth: "2000", photo: undefined,
      parents: ["e2e-child"], spouses: [],
    })));
    data.partial = false;
    data.treePreferences = { ...data.treePreferences, animateOnLoad: false, fragmentThreshold: 0 };
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript(() => {
    const requests: { people: number; previous: boolean; previousInput: boolean }[] = [];
    Object.assign(window, { __projectionRequests: requests });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown) {
        const body = message as { people?: unknown[]; previousGeometry?: unknown; previousInput?: unknown };
        if (body.people) requests.push({ people: body.people.length,
          previous: !!body.previousGeometry, previousInput: !!body.previousInput });
        super.postMessage(message);
      }
    };
  });
  const requests = () => page.evaluate(() => (window as typeof window & {
    __projectionRequests: { people: number; previous: boolean; previousInput: boolean }[];
  }).__projectionRequests);
  await page.goto("/people/e2e-child");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  const before = await requests();
  const collapse = page.getByRole("button", { name: "Свернуть панель", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await familyViewAction(page, "Кровные");
  await expect.poll(async () => (await requests()).length).toBe(before.length + 1);
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  const blood = (await requests()).at(-1)!;
  expect(blood.people).toBeLessThan(before.at(-1)!.people);
  expect(blood.people > 200).toBe(large);
  expect(blood.previous).toBe(false);
  expect(blood.previousInput).toBe(false);
});

test("small close and blood projections use server hashes across fresh browsers and local cache on return", async ({ page, browser, request }) => {
  test.setTimeout(90_000);
  const original = await (await request.get("/api/family")).json();
  const family = original.family as Family, prefix = `scopes-${randomUUID()}`;
  const additions = ["parent", "unrelated"].map((suffix) => ({ ...family.people[0],
    id: `${prefix}-${suffix}`, name: suffix, parents: [], spouses: [], birth: "1938", death: undefined,
    awards: [], events: [], sources: [],
  }));
  const created = await request.post("/api/family/changes", {
    headers: { "If-Match": String(original.revision) }, data: { changes: archiveChanges(family, {
      ...family, people: [...family.people.map(p => p.id === "e2e-spouse"
        ? { ...p, parents: [additions[0].id] } : p), ...additions],
    }) },
  });
  expect(created.status()).toBe(200);
  const contexts = [];
  const warmed = new Map<string, { hash: string; people: string[]; version: number; reverse: boolean }>();
  const prepare = async (target: Page) => {
    await countCalculations(target);
    await target.emulateMedia({ reducedMotion: "reduce" });
    await target.route("**/api/family?projection=overview", async route => {
      const response = await route.fetch(), data = await response.json();
      data.treePreferences = { ...data.treePreferences, animateOnLoad: false, fragmentThreshold: 0, generationLimits: undefined };
      await route.fulfill({ response, json: data });
    });
  };
  const ready = (target: Page) => expect(target.locator(".tree-canvas")).toHaveAttribute("data-layout-ready", "true");
  try {
    await prepare(page);
    for (const view of ["all", "Близкие", "Кровные"]) {
      const sent = page.waitForRequest(r => new URL(r.url()).pathname === "/api/tree-layout");
      if (view === "all") await page.goto("/people/e2e-child");
      else await familyViewAction(page, view);
      const body = (await sent).postDataJSON();
      expect(body.people.length).toBeLessThan(40);
      warmed.set(view, body);
      await ready(page);
      if (view === "all") {
        const collapse = page.getByRole("button", { name: "Свернуть панель", exact: true });
        if (await collapse.isVisible()) await collapse.click();
      }
      await expect.poll(async () => Boolean((await (await request.post("/api/tree-layout", { data: body })).json()).geometry),
        { timeout: 30_000 }).toBe(true);
    }
    expect(new Set([...warmed.values()].map(body => body.hash)).size).toBe(3);
    const context = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: page.viewportSize()! });
    contexts.push(context);
    const fresh = await context.newPage();
    await prepare(fresh);
    for (const view of ["all", "Близкие", "Кровные"]) {
      const response = fresh.waitForResponse(r => new URL(r.url()).pathname === "/api/tree-layout");
      if (view === "all") await fresh.goto("/people/e2e-child");
      else await familyViewAction(fresh, view);
      expect((await (await response).json()).hash).toBe(warmed.get(view)!.hash);
      await ready(fresh);
      if (view === "all") {
        const collapse = fresh.getByRole("button", { name: "Свернуть панель", exact: true });
        if (await collapse.isVisible()) await collapse.click();
      }
      expect(await calculations(fresh)).toBe(0);
    }
    let requests = 0;
    fresh.on("request", r => { if (new URL(r.url()).pathname === "/api/tree-layout") requests++; });
    await familyViewAction(fresh, "Близкие");
    await ready(fresh);
    expect(requests).toBe(0);
    expect(await calculations(fresh)).toBe(0);
  } finally {
    for (const context of contexts) await context.close();
    await page.close();
    const current = await (await request.get("/api/family")).json(), stored = current.family as Family;
    const restored = await request.post("/api/family/changes", {
      headers: { "If-Match": String(current.revision) }, data: { changes: archiveChanges(stored, {
        ...stored, people: stored.people.filter(p => !p.id.startsWith(prefix))
          .map(p => ({ ...p, parents: p.parents.filter(id => !id.startsWith(prefix)) })),
      }) },
    });
    expect(restored.status()).toBe(200);
  }
});

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
