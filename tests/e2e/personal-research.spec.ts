import { test, expect } from "@playwright/test";

test("personal bookmarks survive reload and the compact condition builder saves reusable searches", async ({
  page,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/people");
  const directory = page.locator(".people-directory");
  await expect(directory.locator(".directory-person").first()).toBeVisible();
  const row = directory
    .locator("li")
    .filter({ has: page.locator('a[href$="/e2e-child"]') });
  await expect(row).toBeVisible();
  await row
    .getByRole("button", { name: "Добавить в закладки", exact: true })
    .click();
  await expect(
    row.getByRole("button", { name: "Удалить из закладок", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  await page
    .getByRole("button", { name: "Личные закладки", exact: true })
    .click();
  const bookmarks = page.locator(".bookmarks-popover");
  await expect(
    bookmarks.getByRole("link", { name: /Тестов Пётр Иванович/ }),
  ).toHaveAttribute("href", "/people/e2e-child");
  await page.keyboard.press("Escape");
  await expect(bookmarks).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "Личные закладки", exact: true }),
  ).toBeFocused();

  await page
    .getByRole("button", { name: "Условия поиска", exact: true })
    .click();
  await page.getByLabel("Значение условия 1", { exact: true }).fill("Тестов");
  await page.getByRole("button", { name: "Условие", exact: true }).click();
  await page
    .getByLabel("Условие 2", { exact: true })
    .selectOption("birthYearFrom");
  await page.getByLabel("Значение условия 2", { exact: true }).fill("1960");
  await page.getByRole("button", { name: "Применить", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Найдено:" }),
  ).toBeVisible();
  await expect(directory.locator('a[href$="/e2e-child"]')).toBeVisible();
  await expect(
    directory.locator('a[href$="/e2e-memorial-person"]'),
  ).toHaveCount(0);
  const name = `Проверка поиска ${info.project.name}`;
  await page.getByLabel("Название сохранённого поиска").fill(name);
  await page.getByLabel("Значение условия 2", { exact: true }).fill("1961");
  await expect(
    page.getByRole("button", { name: "Сохранить поиск", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Значение условия 2", { exact: true }).fill("1960");
  await page
    .getByRole("button", { name: "Сохранить поиск", exact: true })
    .click();
  await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(
    directory.locator('a[href$="/e2e-memorial-person"]'),
  ).toBeVisible();
  await page.getByRole("button", { name, exact: true }).click();
  await expect(
    directory.locator('a[href$="/e2e-memorial-person"]'),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Значение условия 2", { exact: true }),
  ).toHaveValue("1960");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `.tmp-ui-review/personal-research-${info.project.name}.png`,
  });
  await page
    .getByRole("button", { name: `Удалить поиск: ${name}`, exact: true })
    .click();
  await expect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
  await directory
    .locator('li:has(a[href$="/e2e-child"])')
    .getByRole("button", { name: "Удалить из закладок", exact: true })
    .click();
});

test("audit undo previews the entire operation and requires an explicit confirmation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let applied = 0;
  await page.route("**/api/audit?*", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 42,
            revision: 8,
            at: "2026-10-20T12:00:00Z",
            actorId: "local",
            actorName: "Владелец",
            action: "Изменено",
            entity: "people",
            entityId: "e2e-child",
            label: "Тестов Пётр Иванович",
            details: [{ field: "Имя", before: "Пётр", after: "Павел" }],
          },
        ],
        next: null,
      },
    }),
  );
  await page.route("**/api/audit/transactions/8/preview", (route) =>
    route.fulfill({
      json: {
        revision: 8,
        currentRevision: 12,
        changes: 2,
        canUndo: true,
        entries: [
          { action: "Изменено", label: "Тестов Пётр Иванович" },
          { action: "Изменено", label: "Тестова Елена Сергеевна" },
        ],
      },
    }),
  );
  await page.route("**/api/audit/transactions/8/undo", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["if-match"]).toBe("12");
    applied += 1;
    await route.fulfill({ json: { applied: true, revision: 13 } });
  });
  await page.goto("/people/e2e-child");
  await page.getByLabel("Другие действия с человеком", { exact: true }).click();
  await page
    .getByRole("button", { name: "История изменений человека", exact: true })
    .click();
  const history = page.getByRole("dialog", {
    name: "История изменений человека",
    exact: true,
  });
  await history.locator(".audit-entry > summary").click();
  await history
    .getByRole("button", {
      name: "Проверить отмену всей операции",
      exact: true,
    })
    .click();
  await expect(
    history.getByText("Изменено: Тестова Елена Сергеевна", { exact: true }),
  ).toBeVisible();
  expect(applied).toBe(0);
  await history
    .getByRole("button", { name: "Отменить операцию", exact: true })
    .click();
  await expect.poll(() => applied).toBe(1);
});
