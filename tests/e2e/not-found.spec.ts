import { expect, test } from "@playwright/test";

test("404 лёгкая, доступная и возвращает на главную без загрузки архива", async ({
  page,
  isMobile,
}, info) => {
  const api: string[] = [];
  const errors: string[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith("/api/"))
      api.push(request.url());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  if (isMobile) await page.setViewportSize({ width: 320, height: 720 });
  const response = await page.goto("/this-page-does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Здесь пока нет ветви" }),
  ).toBeVisible();
  await expect(page).toHaveTitle("Страница не найдена · Drevo");
  expect(api).toEqual([]);
  expect(errors).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("link", { name: "Drevo — на главную" }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  const home = page.getByRole("link", { name: /На главную/ });
  await expect(home).toBeFocused();
  await page.screenshot({ path: info.outputPath("404.png") });
  await home.click();
  await expect(page.locator(".tree-canvas")).toBeVisible();
});
