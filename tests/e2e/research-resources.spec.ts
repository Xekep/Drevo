import { expect, test } from "@playwright/test";

test("администратор редактирует каталог ресурсов для ИИ", async ({
  page,
}, testInfo) => {
  const categoryName = `${testInfo.project.name} локальные архивы`;
  await page.goto("/admin");
  await page.getByRole("button", { name: "Ресурсы поиска" }).click();
  await expect(
    page.getByRole("heading", { name: "Сайты для поиска" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /Война/ })).toBeVisible();

  await page.getByLabel("Новая категория").fill(categoryName);
  await page.getByRole("button", { name: "Добавить категорию" }).click();
  await expect(
    page.getByRole("heading", { name: "Ресурсы", exact: true }),
  ).toBeVisible();
  await expect(page.locator("#research-category-name")).toHaveValue(
    categoryName,
  );

  await page.getByRole("button", { name: "Добавить ресурс" }).click();
  const editor = page.locator(".research-resources-editor");
  await editor.getByLabel("Название").fill("Городской архив");
  await editor.getByLabel("Ссылка").fill("https://example.org/archive");
  await editor
    .getByLabel("Описание")
    .fill("Метрические книги\nи архивные описи");
  await editor.getByRole("button", { name: "Сохранить ресурс" }).click();
  await expect(page.locator(".research-resources-list")).toContainText(
    "Городской архив",
  );
  await expect(page.locator(".research-resources-list")).toContainText(
    "архивные описи",
  );

  await page
    .locator(".research-resources-list article")
    .filter({ hasText: "Городской архив" })
    .getByRole("button", { name: "Изменить" })
    .click();
  await editor.getByLabel("Название").fill("Исторический архив");
  await editor.getByRole("button", { name: "Сохранить ресурс" }).click();
  await expect(page.locator(".research-resources-list")).toContainText(
    "Исторический архив",
  );
  await expect(page.locator(".research-resources-list")).not.toContainText(
    "Городской архив",
  );

  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});
