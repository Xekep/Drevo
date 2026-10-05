import { expect, test, type Page } from "@playwright/test";
import { renderPortraits } from "./render-portraits";

async function portraitFixture(page: Page, accountPortrait: boolean, terminalStatus?: number) {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const person = data.family.people.find((item: { id: string }) =>
      item.id === "e2e-memorial-person");
    expect(person).toBeTruthy();
    person.photo = "/media/transient-portrait.jpg";
    data.user.personId = accountPortrait ? person.id : null;
    await route.fulfill({ response, json: data });
  });
  const image = (await renderPortraits(["transient"])).get("transient-thumb")!;
  let requests = 0;
  await page.route("**/media/transient-portrait.jpg?variant=thumb*", (route) => {
    requests++;
    return terminalStatus || requests === 1
      ? route.fulfill({ status: terminalStatus || 503, contentType: "application/json",
        headers: { "Cache-Control": "no-store" }, body: '{"error":"retry"}' })
      : route.fulfill({ status: 200, contentType: "image/jpeg", body: image });
  });
  return { requests: () => requests };
}

test("account portrait recovers from a transient media delivery conflict", async ({ page }) => {
  const fixture = await portraitFixture(page, true);
  await page.goto("/account");
  await expect.poll(fixture.requests).toBeGreaterThanOrEqual(1);
  await expect.poll(fixture.requests, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
  await expect(page.locator(".nav-account-avatar img")).toHaveJSProperty("naturalWidth", 400);
});

test("a stalled status probe times out and leaves the account menu usable", async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    const windowWithProbe = window as typeof window & {
      portraitProbeStarted?: boolean; portraitProbeAborted?: boolean;
    };
    window.fetch = (input, init) => {
      if (!String(input).includes("/media/transient-portrait.jpg"))
        return originalFetch(input, init);
      windowWithProbe.portraitProbeStarted = true;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          windowWithProbe.portraitProbeAborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    };
  });
  const fixture = await portraitFixture(page, true, 503);
  await page.goto("/account");
  await expect.poll(fixture.requests).toBeGreaterThanOrEqual(1);
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { portraitProbeStarted?: boolean }).portraitProbeStarted === true),
  { timeout: 5_000 }).toBe(true);
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { portraitProbeAborted?: boolean }).portraitProbeAborted === true),
  { timeout: 8_000 }).toBe(true);
  await page.locator(".nav-account-avatar").click();
  await expect(page.getByRole("link", { name: "Личный кабинет" })).toBeVisible();
});

for (const status of [403, 404]) {
  test(`account portrait does not retry a terminal ${status}`, async ({ page }) => {
    const fixture = await portraitFixture(page, true, status);
    await page.goto("/account");
    await expect.poll(fixture.requests).toBeGreaterThanOrEqual(2);
    await page.waitForTimeout(1800);
    expect(fixture.requests()).toBe(2);
    await expect(page.locator(".nav-account-avatar img")).toHaveCount(0);
  });
}

test("a visible tree portrait recovers without moving the camera", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      if (args[0] === "webgl2") return null;
      return Reflect.apply(getContext, this, args);
    } as typeof getContext;
  });
  const fixture = await portraitFixture(page, false);
  await page.goto("/tree");
  const card = page.locator('[data-person-id="e2e-memorial-person"]');
  await expect(card).toBeVisible();
  await expect.poll(fixture.requests).toBeGreaterThanOrEqual(1);
  await expect.poll(fixture.requests, { timeout: 12_000 }).toBeGreaterThanOrEqual(2);
  await expect(card.locator(".person-avatar img")).toHaveJSProperty("naturalWidth", 400);
});

test("the distant portrait layer recovers from one transient tiny response", async ({ page }) => {
  test.setTimeout(45_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      if (args[0] === "webgl2") return null;
      return Reflect.apply(getContext, this, args);
    } as typeof getContext;
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const seed = data.family.people[0];
    data.family.people = Array.from({ length: 600 }, (_, index) => ({
      ...seed, id: `portrait-distant-${index}`, name: `Человек ${index}`,
      birth: `${1700 + (index % 12) * 24}-01-01`,
      parents: index % 12 ? [`portrait-distant-${index - 1}`] : [],
      spouses: [], sources: [], photo: "/media/distant-transient.jpg",
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  const images = await renderPortraits(["distant"]);
  let tinyRequests = 0;
  await page.route("**/media/distant-transient.jpg?variant=*", (route) => {
    const tiny = new URL(route.request().url()).searchParams.get("variant") === "tiny";
    if (tiny && ++tinyRequests === 1)
      return route.fulfill({ status: 503, contentType: "application/json",
        headers: { "Cache-Control": "no-store" }, body: '{"error":"retry"}' });
    return route.fulfill({ contentType: "image/jpeg",
      body: images.get(tiny ? "distant-tiny" : "distant-thumb")! });
  });
  await page.goto("/tree");
  await expect.poll(() => tinyRequests, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => Number(await page.locator(".tree-distant-portraits")
    .getAttribute("data-portrait-count")), { timeout: 20_000 }).toBeGreaterThan(0);
});

test("stalled distant portraits release their slots for later visible faces", async ({ page }) => {
  test.setTimeout(50_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      if (args[0] === "webgl2") return null;
      return Reflect.apply(getContext, this, args);
    } as typeof getContext;
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const seed = data.family.people[0];
    data.family.people = Array.from({ length: 600 }, (_, index) => ({
      ...seed, id: `portrait-stall-${index}`, name: `Visible person ${index}`,
      birth: `${1700 + (index % 12) * 24}-01-01`,
      parents: index % 12 ? [`portrait-stall-${index - 1}`] : [],
      spouses: [], sources: [], photo: `/media/portrait-stall-${index}.jpg`,
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  const image = (await renderPortraits(["distant-stall"])).get("distant-stall-tiny")!;
  const held: Array<() => Promise<void>> = [];
  let requests = 0;
  await page.route("**/media/portrait-stall-*.jpg?variant=tiny*", async (route) => {
    requests++;
    if (requests <= 12) {
      await new Promise<void>((resolve) => {
        held.push(async () => {
          await route.fulfill({ contentType: "image/jpeg", body: image });
          resolve();
        });
      });
    } else await route.fulfill({ contentType: "image/jpeg", body: image });
  });
  try {
    await page.goto("/tree", { waitUntil: "domcontentloaded" });
    await expect.poll(() => requests, { timeout: 15_000 }).toBeGreaterThanOrEqual(12);
    await expect.poll(() => requests, { timeout: 25_000 }).toBeGreaterThan(12);
    await expect.poll(async () => Number(await page.locator(".tree-distant-portraits")
      .getAttribute("data-portrait-count")), { timeout: 10_000 }).toBeGreaterThan(0);
  } finally {
    await Promise.allSettled(held.map((release) => release()));
  }
});
