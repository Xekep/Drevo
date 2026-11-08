import { expect, test, type Page } from "@playwright/test";

async function expectReachable(page: Page) {
  const launcher = page.getByRole("button", { name: "Открыть ИИ-исследователя", exact: true });
  await expect(launcher).toBeVisible();
  await expect.poll(() => launcher.evaluate(button => {
    const rect = button.getBoundingClientRect();
    return rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth &&
      rect.bottom <= window.innerHeight && button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(true);
  return launcher;
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("mobile assistant stays reachable with a person and returns beside controls after closing it", async ({ page, isMobile }) => {
  test.skip(!isMobile);
  await page.goto("/tree");
  await expectReachable(page);
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  const launcher = await expectReachable(page);
  await page.getByRole("button", { name: "Свернуть панель", exact: true }).click();
  await expect(page.locator(".inspector-dock")).not.toHaveClass(/expanded/);
  await expectReachable(page);
  await page.getByRole("button", { name: "Закрыть панель", exact: true }).click();
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
  await expectReachable(page);
  const fullscreen = page.locator(".flow-fullscreen-tools");
  await expect(fullscreen).toBeVisible();
  await expect.poll(async () => {
    const button = (await launcher.boundingBox())!;
    const controls = (await fullscreen.boundingBox())!;
    return button.x + button.width <= controls.x - 4;
  }).toBe(true);
});

test("assistant stays inside the viewport and clickable across archive tabs and timeline", async ({ page }) => {
  for (const path of ["/people", "/families", "/photos", "/documents", "/places", "/insights", "/resources", "/quality", "/tree"]) {
    await page.goto(path);
    await expectReachable(page);
  }
  await page.getByRole("button", { name: "Хронология", exact: true })
    .or(page.getByRole("switch", { name: "Древо / Хронология" })).click();
  await expect(page.locator(".tree-canvas")).toHaveClass(/mode-timeline/);
  await expectReachable(page);
});

test("modal settings cover the assistant and closing them restores access", async ({ page }) => {
  await page.goto("/tree");
  const launcher = await expectReachable(page);
  await page.getByRole("button", { name: "Настройки древа", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect.poll(() => launcher.evaluate(button => {
    const rect = button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  })).toBe(false);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expectReachable(page);
});

for (const fallback of [false, true]) {
  test(`assistant does not overlay fullscreen and returns after exit (${fallback ? "CSS fallback" : "native"})`, async ({ page, isMobile }) => {
    test.skip(!isMobile);
    if (fallback) await page.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new Error("Fullscreen unavailable"));
    });
    await page.goto("/tree");
    const launcher = await expectReachable(page);
    await page.getByRole("button", { name: "Развернуть на весь экран", exact: true }).click();
    await expect(page.locator(".tree-canvas")).toHaveClass(/is-fullscreen/);
    await expect.poll(() => launcher.evaluate(button => {
      const rect = button.getBoundingClientRect();
      return button.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
    })).toBe(false);
    await page.goBack();
    await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-fullscreen/);
    await expectReachable(page);
  });
}
