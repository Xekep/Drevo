import { expect, test } from "@playwright/test";

test("краткие описания раскрываются клавиатурой, поиск учитывает скрытый текст", async ({
  page,
}) => {
  const description =
    "Метрические книги и переписи для исследования семьи. ".repeat(5) +
    "Уникальная подсказка: адресные книги Екатеринбурга.";
  await page.route("**/api/research-resources", (route) =>
    route.fulfill({
      json: {
        categories: [
          {
            id: "audit-category",
            name: "Архивы",
            resources: [
              {
                id: "audit-long",
                name: "Региональный архив",
                url: "https://example.org/archive",
                description,
              },
              {
                id: "audit-short",
                name: "Короткое описание",
                url: "https://пример.рф",
                description: "Книги регистрации рождения.",
              },
            ],
          },
        ],
      },
    }),
  );
  await page.goto("/resources");
  const directory = page.locator(".research-directory");
  const row = directory.locator("li").filter({ hasText: "Региональный архив" });
  const disclosure = row.locator("details");
  const toggle = disclosure.locator("summary");
  await expect(toggle).toContainText("Подробнее");
  await expect(disclosure).not.toHaveAttribute("open", "");
  await expect(disclosure.locator("p")).toBeHidden();
  await toggle.focus();
  await expect(toggle).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(disclosure).toHaveAttribute("open", "");
  await expect(disclosure.locator("p")).toHaveText(description);
  await expect(disclosure.locator("p")).toBeVisible();
  await expect(toggle).toBeFocused();
  await expect(toggle).toContainText("Свернуть");
  await page.keyboard.press("Enter");
  await expect(disclosure.locator("p")).toBeHidden();

  await directory
    .getByRole("searchbox", { name: "Найти ресурс" })
    .fill("Екатеринбурга");
  await expect(row).toBeVisible();
  await expect(directory.locator("li")).toHaveCount(1);
  await directory
    .getByRole("button", { name: "Очистить поиск ресурсов" })
    .click();
  const short = directory
    .locator("li")
    .filter({ hasText: "Короткое описание" });
  await expect(short.locator("details")).toHaveCount(0);
  await expect(short).toContainText("Книги регистрации рождения.");
  await expect(short.locator("small")).toHaveText("Внешний сайт");
  await expect(short.getByRole("link")).toHaveAttribute(
    "href",
    "https://xn--e1afmkfd.xn--p1ai/",
  );
  await expect(short.getByRole("link")).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await toggle.click();
    await expect(disclosure.locator("p")).toBeVisible();
    expect(
      await row.evaluate(
        (element) => element.getBoundingClientRect().right <= innerWidth,
      ),
    ).toBe(true);
    await toggle.click();
  }
});
