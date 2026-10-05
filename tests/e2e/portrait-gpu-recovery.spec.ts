import { expect, test } from "@playwright/test";
import { renderPortraits } from "./render-portraits";

test.use({
  launchOptions: {
    args: ["--enable-unsafe-swiftshader"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  },
});

test("GPU portraits recover after a transient preview denial", async ({ page }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const get = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
      return parameter === 37446 ? "Drevo GPU portrait recovery" : get.call(this, parameter);
    };
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const seed = data.family.people[0];
    data.family.people = Array.from({ length: 1000 }, (_, index) => ({
      ...seed, id: `gpu-recovery-${index}`, name: `Человек ${index}`,
      birth: `${1700 + (index % 12) * 24}-01-01`,
      parents: index % 12 ? [`gpu-recovery-${index - 1}`] : [],
      spouses: [], sources: [], photo: "/media/gpu-transient.jpg",
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  const images = await renderPortraits(["gpu"]);
  const requests = { tiny: 0, thumb: 0 };
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  await page.route("**/media/gpu-transient.jpg?variant=*", async (route) => {
    const variant = new URL(route.request().url()).searchParams.get("variant") as "tiny" | "thumb";
    requests[variant]++;
    if (variant === "tiny" && requests.tiny === 1) await firstGate;
    return requests[variant] === 1
      ? route.fulfill({ status: 503, contentType: "application/json",
        headers: { "Cache-Control": "no-store" }, body: '{"error":"retry"}' })
      : route.fulfill({ contentType: "image/jpeg", body: images.get(`gpu-${variant}`)! });
  });
  await page.goto("/tree", { waitUntil: "domcontentloaded" });
  const gpu = page.locator('.tree-canvas[data-renderer="webgl2"] .tree-gpu-scene');
  await expect(gpu).toBeVisible({ timeout: 30_000 });
  await gpu.evaluate((element) => {
    const root = element.closest(".tree-canvas")!;
    const box = root.getBoundingClientRect();
    const viewport = root.querySelector(".react-flow__viewport")!;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
      ctrlKey: true, deltaY: -Math.log(0.12 / zoom) / 0.002,
      clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
  });
  releaseFirst();
  await expect.poll(() => requests.tiny + requests.thumb, { timeout: 20_000 }).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => Number(await gpu.getAttribute("data-gpu-visible-photos")),
    { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(async () => Number(await gpu.getAttribute("data-gpu-textured-photos")),
    { timeout: 20_000 }).toBeGreaterThan(0);
});

test("visible GPU and distant status probes keep their combined request budget", async ({ page, isMobile }) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const get = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
      return parameter === 37446 ? "Drevo GPU portrait budget" : get.call(this, parameter);
    };
    const originalFetch = window.fetch.bind(window);
    const state = { active: 0, maximum: 0 };
    (window as typeof window & { portraitProbeBudget?: typeof state }).portraitProbeBudget = state;
    window.fetch = (input, init) => {
      if (!String(input).includes("/media/gpu-budget-")) return originalFetch(input, init);
      state.active++;
      state.maximum = Math.max(state.maximum, state.active);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          state.active--;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      });
    };
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const seed = data.family.people[0];
    data.family.people = Array.from({ length: 1000 }, (_, index) => ({
      ...seed, id: `gpu-budget-${index}`, name: `Человек ${index}`,
      birth: `${1700 + (index % 12) * 24}-01-01`,
      parents: index % 12 ? [`gpu-budget-${index - 1}`] : [],
      spouses: [], sources: [], photo: `/media/gpu-budget-${index % 20}.jpg`,
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/media/gpu-budget-*.jpg?variant=*", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }));
  await page.goto("/tree", { waitUntil: "domcontentloaded" });
  const gpu = page.locator('.tree-canvas[data-renderer="webgl2"] .tree-gpu-scene');
  await expect(gpu).toBeVisible({ timeout: 30_000 });
  await gpu.evaluate((element) => {
    const root = element.closest(".tree-canvas")!;
    const box = root.getBoundingClientRect();
    const viewport = root.querySelector(".react-flow__viewport")!;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    root.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
      ctrlKey: true, deltaY: -Math.log(0.12 / zoom) / 0.002,
      clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
  });
  const maximum = () => page.evaluate(() =>
    (window as typeof window & { portraitProbeBudget?: { maximum: number } })
      .portraitProbeBudget?.maximum || 0);
  await expect.poll(maximum, { timeout: 20_000 }).toBeGreaterThanOrEqual(6);
  await page.waitForTimeout(700);
  expect(await maximum()).toBeLessThanOrEqual(18);
  if (isMobile) await page.getByRole("switch", { name: "Древо / Хронология" }).click();
  else await page.getByRole("button", { name: "Хронология", exact: true }).click();
  await expect(page.locator(".tree-gpu-scene")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { portraitProbeBudget?: { active: number } })
      .portraitProbeBudget?.active || 0)).toBe(0);
});
