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
  await editor
    .getByLabel("Категории веб-поиска (через запятую)")
    .fill("archives,education");
  await editor.getByLabel("Приоритет поиска").fill("25");
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
  await expect(editor.getByLabel("Домен поиска")).toHaveValue("example.org");
  await expect(
    editor.getByLabel("Категории веб-поиска (через запятую)"),
  ).toHaveValue("archives,education");
  await expect(editor.getByLabel("Приоритет поиска")).toHaveValue("25");
  await editor.getByLabel("Разрешить веб-поиск ИИ по этому ресурсу").uncheck();
  await editor.getByLabel("Название").fill("Исторический архив");
  await editor.getByRole("button", { name: "Сохранить ресурс" }).click();
  await expect(page.locator(".research-resources-list")).toContainText(
    "Исторический архив",
  );
  await expect(page.locator(".research-resources-list")).not.toContainText(
    "Городской архив",
  );

  const catalogue = await page.request
    .get("/api/admin/research-resources")
    .then((response) => response.json());
  const saved = catalogue.categories.find(
    (category: { name: string }) => category.name === categoryName,
  ).resources[0];
  expect(saved.enabledForAiSearch).toBe(false);
  expect(saved.categories).toEqual(["archives", "education"]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});
