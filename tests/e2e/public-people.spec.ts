import { expect, test } from "@playwright/test";

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
