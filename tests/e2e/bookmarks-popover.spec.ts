import { expect, test } from "@playwright/test";

test("bookmarks stay inside the viewport with a fixed header and a scrollable list", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/bookmarks", (route) =>
    route.fulfill({
      json: {
        items: Array.from({ length: 30 }, (_, index) => ({
          kind: "person",
          id: `bookmark-${index}`,
          href: "/people/e2e-child",
          label: `Родственник ${index + 1} с длинной фамилией и отчеством`,
        })),
        unavailable: 0,
      },
    }),
  );
  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/people");
  const button = page.getByRole("button", {
    name: "Личные закладки",
    exact: true,
  });
  const panel = page.getByRole("region", {
    name: "Личные закладки",
    exact: true,
  });
  await button.click();
  await expect(panel.getByRole("link")).toHaveCount(30);
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 640, height: 360 },
    { width: 1280, height: 720 },
  ]) {
    await page.setViewportSize(viewport);
    await expect
      .poll(async () => {
        const box = (await panel.boundingBox())!;
        return (
          box.x >= 8 &&
          box.x + box.width <= viewport.width - 7 &&
          box.y >= 8 &&
          box.y + box.height <= viewport.height - 7
        );
      })
      .toBe(true);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const close = panel.getByRole("button", { name: "Закрыть закладки" });
  const headerTop = (await close.boundingBox())!.y;
  await panel.getByRole("link").last().scrollIntoViewIfNeeded();
  await expect(close).toBeInViewport();
  expect((await close.boundingBox())!.y).toBeCloseTo(headerTop, 0);
  const search = panel.getByRole("searchbox", { name: "Найти в закладках" });
  await search.fill("Родственник 30 ");
  await expect(panel.getByRole("link")).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("bookmarks-mobile.png") });
  await close.click();
  await expect(panel).not.toBeVisible();
  await expect(button).toBeFocused();
  await button.click();
  await page.keyboard.press("Escape");
  await expect(panel).not.toBeVisible();
  await expect(button).toBeFocused();
  await button.click();
  await page.mouse.click(8, 820);
  await expect(panel).not.toBeVisible();
});
