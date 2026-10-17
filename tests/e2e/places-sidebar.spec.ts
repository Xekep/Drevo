import { expect, test } from "@playwright/test";

test("карта использует всю высоту, а список можно скрыть и вернуть без потери места", async ({ page, isMobile }, info) => {
  await page.route("**://tile.openstreetmap.org/**", route => route.abort());
  await page.route("**/api/places/locate?*", route => route.fulfill({ json: {
    automatic: { lat: 55.75, lon: 37.62, name: "Москва", label: "Москва" },
    candidates: [],
  } }));
  await page.goto("/places");
  const panel = page.locator(".places-sidebar");
  const map = page.locator(".family-map-surface");
  await expect(page.locator(".places-heading")).toHaveCount(0);
  await expect(page.locator(".places-count")).toHaveText("1 место · 1 на карте");
  const mapBox = await map.boundingBox();
  const navigationBox = await page.getByRole("banner").boundingBox();
  expect(mapBox!.y - (navigationBox!.y + navigationBox!.height)).toBeLessThan(2);
  if (isMobile) {
    await expect(panel).toBeHidden();
    await page.getByRole("button", { name: "Показать список мест", exact: true }).click();
    await expect(panel).toBeVisible();
    await expect(panel.locator(".places-count")).toBeVisible();
    await page.getByRole("button", { name: "Закрыть список мест", exact: true }).click();
    await expect(panel).toBeHidden();
  } else {
    await expect(panel).toBeVisible();
    const width = mapBox!.width;
    await page.getByRole("button", { name: "Скрыть список мест", exact: true }).click();
    await expect(panel).toBeHidden();
    await expect.poll(async () => (await map.boundingBox())!.width).toBeGreaterThan(width + 319);
    // Choosing a marker opens its details even after the panel was hidden.
    await page.locator(".family-map-pin").first().click();
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("heading", { name: "Москва", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Скрыть список мест", exact: true }).click();
    await page.getByRole("button", { name: "Показать список мест", exact: true }).click();
    await expect(panel.getByRole("heading", { name: "Москва", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Скрыть список мест", exact: true }).click();
    // Desktop hiding does not disable the independent mobile drawer.
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeVisible();
    await page.getByRole("button", { name: "Закрыть список мест", exact: true }).click();
    await page.getByRole("button", { name: "Показать список мест", exact: true }).click();
    await expect(panel.locator(".places-count")).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath("places-panel.png") });
});
