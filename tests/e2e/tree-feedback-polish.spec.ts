import { expect, test } from "@playwright/test";

test("archive loading text does not become a page selection before data arrives", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/family?projection=overview", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/people", { waitUntil: "domcontentloaded" });
  try {
    await expect(page.getByRole("status", { name: "Загрузка архива" })).toBeVisible();
    await page.keyboard.press("Control+A");
    expect(await page.evaluate(() => window.getSelection()?.toString() || "")).toBe("");
  } finally { release(); }
  await expect(page.getByRole("combobox", { name: "Найти человека" })).toBeVisible();
});

test("tree explains layout preparation until the worker is ready", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/layout\.worker(?:\.ts|-[^/?]+\.js)(?:\?.*)?$/, async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/tree");
  try {
    const status = page.locator(".tree-preparation-status");
    await expect(status).toContainText("Расставляем карточки и связи");
    await expect(status).toBeVisible();
    await expect(page.locator(".tree-canvas")).toHaveAttribute("aria-busy", "true");
  } finally { release(); }
  await expect(page.locator(".tree-preparation-status")).toHaveCount(0, { timeout: 20_000 });
});

test("profile shows a visible spinner and text while details are loading", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/family?projection=details*", async (route) => {
    await gate;
    await route.continue();
  });
  await page.goto("/people/e2e-child");
  try {
    const status = page.locator(".person-details-status");
    await expect(status).toContainText("Загружаем сведения о человеке");
    await expect(status).toBeVisible();
    const ring = await status.locator(".archive-loader-ring").boundingBox();
    expect(ring!.width).toBeGreaterThanOrEqual(30);
    expect(ring!.height).toBeGreaterThanOrEqual(30);
  } finally { release(); }
  await expect(page.locator(".person-details-status")).toHaveCount(0);
});

test("overview stays sharp and below tree navigation", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-camera-ready", "true");
  await expect(page.locator(".tree-preparation-status")).toHaveCount(0);
  const bounds = (await page.locator(".tree-canvas").boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, 2200);
  await page.keyboard.up("Control");
  const canvas = page.locator(".tree-distant-portraits");
  await expect(canvas).toBeVisible();
  await expect.poll(() => page.locator(".react-flow__viewport").evaluate((element) =>
    new DOMMatrix(getComputedStyle(element).transform).a)).toBeLessThan(0.18);
  const density = await canvas.evaluate((element: HTMLCanvasElement) =>
    element.width / parseFloat(getComputedStyle(element).width));
  expect(density).toBeCloseTo(Math.min(info.project.use.deviceScaleFactor || 1, 2), 1);
  const tool = page.getByRole("button", { name: "Вписать видимую часть древа", exact: true });
  await expect(tool).toBeVisible();
  expect(await tool.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  await tool.click();
});
