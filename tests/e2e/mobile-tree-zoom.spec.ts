import { expect, test, type CDPSession, type Page } from "@playwright/test";

async function pinch(page: Page, session: CDPSession, x: number, y: number) {
  const points = (distance: number) => [
    { x: x - distance, y, id: 1 },
    { x: x + distance, y, id: 2 },
  ];
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart", touchPoints: points(22),
  });
  for (let step = 1; step <= 12; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: points(22 + step * 5),
    });
    await page.waitForTimeout(16);
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd", touchPoints: [],
  });
  // Chromium's compositor can update the visual viewport after touchend.
  await page.waitForTimeout(80);
}

async function pageScale(page: Page) {
  return page.evaluate(() => window.visualViewport?.scale ?? 1);
}

test("mobile pinch belongs to the tree from loading through growth, then moves its camera", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  let releaseOverview!: () => void, releaseLayout!: () => void;
  const overview = new Promise<void>((resolve) => { releaseOverview = resolve; });
  const layout = new Promise<void>((resolve) => { releaseLayout = resolve; });
  await page.route("**/api/family?projection=overview", async (route) => {
    await overview;
    await route.continue();
  });
  await page.route(/\/assets\/layout\.worker-[^/]+\.js$/, async (route) => {
    await layout;
    await route.continue();
  });
  const session = await page.context().newCDPSession(page);
  const header = page.locator(".archive-header");
  const canvas = page.locator(".tree-canvas");
  try {
    await page.goto("/tree", { waitUntil: "domcontentloaded" });
    const loading = page.getByRole("status", { name: "Загрузка архива" });
    await expect(loading).toBeVisible();
    await expect(loading).toHaveCSS("touch-action", "none");
    const headerBefore = (await header.boundingBox())!;
    const loadingBox = (await loading.boundingBox())!;
    expect(loadingBox.y).toBeGreaterThanOrEqual(headerBefore.y + headerBefore.height - 1);
    expect(loadingBox.y + loadingBox.height).toBeGreaterThanOrEqual(843);
    const x = 195, y = 490;
    await pinch(page, session, x, y);
    expect(await pageScale(page)).toBeCloseTo(1, 3);

    releaseOverview();
    await expect(canvas).toHaveClass(/is-growth-preparing/);
    await pinch(page, session, x, y);
    expect(await pageScale(page)).toBeCloseTo(1, 3);
    releaseLayout();
    await expect(canvas).toHaveClass(/is-growing/);
    await pinch(page, session, x, y);
    expect(await pageScale(page)).toBeCloseTo(1, 3);
    await expect(canvas).not.toHaveClass(/is-grow/);
    const viewport = page.locator(".react-flow__viewport");
    const zoomBefore = await viewport.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a);
    await pinch(page, session, x, y);
    await expect.poll(() => viewport.evaluate((node) => new DOMMatrix(getComputedStyle(node).transform).a))
      .toBeGreaterThan(zoomBefore * 1.2);
    expect(await pageScale(page)).toBeCloseTo(1, 3);
    const headerAfter = (await header.boundingBox())!;
    expect(headerAfter.y).toBeCloseTo(headerBefore.y, 1);
    expect(headerAfter.height).toBeCloseTo(headerBefore.height, 1);
    await expect(page.locator('summary[aria-label="Меню проекта"]')).toBeVisible();
  } finally {
    releaseOverview();
    releaseLayout();
    await session.detach();
  }
});

test("mobile native page zoom remains available outside the canvas and on ordinary section loaders", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  let releaseOverview!: () => void;
  const overview = new Promise<void>((resolve) => { releaseOverview = resolve; });
  await page.route("**/api/family?projection=overview", async (route) => {
    await overview;
    await route.continue();
  });
  const session = await page.context().newCDPSession(page);
  try {
    await page.goto("/people", { waitUntil: "domcontentloaded" });
    const loading = page.getByRole("status", { name: "Загрузка архива" });
    await expect(loading).toBeVisible();
    await expect(loading).toHaveCSS("touch-action", "auto");
    expect(await page.locator('meta[name="viewport"]').getAttribute("content"))
      .not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
    await pinch(page, session, 195, 350);
    await expect.poll(() => pageScale(page)).toBeGreaterThan(1.2);
    releaseOverview();
    await expect(page.getByRole("heading", { name: /^Люди/ })).toBeVisible();
  } finally {
    releaseOverview();
    await session.detach();
  }
});

test("mobile tree gesture boundary fills the viewport while the application chunk loads", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  let releaseApp!: () => void;
  const app = new Promise<void>((resolve) => { releaseApp = resolve; });
  await page.route(/\/assets\/App-[^/]+\.js$/, async (route) => {
    await app;
    await route.continue();
  });
  const session = await page.context().newCDPSession(page);
  try {
    await page.goto("/tree", { waitUntil: "domcontentloaded" });
    const loading = page.locator("#root > .archive-status-loading");
    await expect(loading).toBeVisible();
    expect((await loading.boundingBox())!.height).toBeGreaterThanOrEqual(844);
    await pinch(page, session, 195, 600);
    expect(await pageScale(page)).toBeCloseTo(1, 3);
    releaseApp();
    await expect(page.locator(".tree-canvas")).toBeVisible();
    expect(await pageScale(page)).toBeCloseTo(1, 3);
  } finally {
    releaseApp();
    await session.detach();
  }
});

test("mobile post-login splash owns pinch without leaking zoom to the archive", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  await page.addInitScript(() => sessionStorage.setItem("drevo:entry-sequence", String(Date.now())));
  let releaseOverview!: () => void;
  const overview = new Promise<void>((resolve) => { releaseOverview = resolve; });
  await page.route("**/api/family?projection=overview", async (route) => {
    await overview;
    await route.continue();
  });
  const session = await page.context().newCDPSession(page);
  try {
    await page.goto("/tree", { waitUntil: "domcontentloaded" });
    const entry = page.getByRole("dialog", { name: "Открываем семейный архив" });
    await expect(entry).toBeVisible();
    await pinch(page, session, 195, 490);
    expect(await pageScale(page)).toBeCloseTo(1, 3);
    releaseOverview();
    await expect(entry).toHaveCount(0);
    expect(await pageScale(page)).toBeCloseTo(1, 3);
    await expect(page.locator(".archive-header")).toBeVisible();
  } finally {
    releaseOverview();
    await session.detach();
  }
});
