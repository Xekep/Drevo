import { expect, test } from "@playwright/test";

test("discovery keeps same-ID cards from different archives distinct and paginates", async ({ page }) => {
  await page.route((url) => url.pathname === "/api/discovery/people", (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    return route.fulfill({ json: cursor
      ? { results: [{ archiveId: "tree-c", id: "same", name: "Тестов Внук" }], nextCursor: null }
      : { results: [
          { archiveId: "tree-a", id: "same", name: "Тестов Иван" },
          { archiveId: "tree-b", id: "same", name: "Тестов Павел" },
        ], nextCursor: "next" },
    });
  });
  await page.route("**/api/discovery/people/tree-b/same", (route) =>
    route.fulfill({ json: { person: { archiveId: "tree-b", id: "same", name: "Тестов Павел", birthYear: "1901" } } }),
  );
  await page.goto("/discover");
  await page.getByRole("textbox", { name: "ФИО, год или место" }).fill("Тестов");
  await page.getByRole("button", { name: "Найти" }).click();
  await expect(page).toHaveURL(/\/discover\/search\//);
  await expect(page.locator(".public-person-card")).toHaveCount(2);
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect(page.locator(".public-person-card")).toHaveCount(3);
  await page.getByRole("link", { name: "Тестов Павел" }).click();
  await expect(page.locator(".public-person-card")).toContainText("1901");
  await expect(page).toHaveURL(/\/discover\/person\/tree-b\/same$/);
});

test("admin publishes a person from the card menu and finds the limited public card", async ({ page, isMobile }) => {
  test.skip(isMobile, "Card context menu currently requires a pointing device");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-person-content").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Публикация в поиске" }).click();
  const dialog = page.getByRole("dialog", { name: "Публикация человека в поиске" });
  await expect(dialog.getByRole("button", { name: "Опубликовать в поиске" })).toBeVisible();
  await dialog.getByRole("button", { name: "Опубликовать в поиске" }).click();
  await expect(dialog.getByRole("button", { name: "Снять с поиска" })).toBeVisible();
  await page.goto("/discover?q=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2");
  await expect(page.getByRole("heading", { name: /Тестов Иван/ })).toBeVisible();
  await expect(page.locator(".public-person-card")).toContainText("1940");
  await expect(page.locator(".public-person-card")).not.toContainText("биография");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-person-content").click({ button: "right" });
  await page.getByRole("menuitem", { name: "Публикация в поиске" }).click();
  await dialog.getByRole("button", { name: "Снять с поиска" }).click();
  await expect(dialog.getByRole("button", { name: "Опубликовать в поиске" })).toBeVisible();
});
