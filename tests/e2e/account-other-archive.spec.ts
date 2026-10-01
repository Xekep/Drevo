import { expect, test } from "@playwright/test";

test("account without membership in the current archive can open another tree", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ status: 401, json: { error: "Private archive" } }),
  );
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        user: null,
        account: {
          id: "other-only",
          name: "Другой участник",
          createdAt: "2026-09-30",
          fullAccess: false,
          provider: "yandex",
        },
        local: false,
        canEdit: false,
        yandex: true,
        vk: false,
      },
    }),
  );
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({
      json: {
        archives: [
          {
            id: "other-archive",
            title: "Дерево семьи",
            role: "reader",
            approved: true,
            current: false,
          },
        ],
      },
    }),
  );
  await page.route("**/api/account/sessions", (route) =>
    route.fulfill({ json: { currentExpiresAt: null, otherCount: 0 } }),
  );

  await page.goto("/account");
  await expect(
    page.getByRole("heading", { name: "Личный кабинет" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Мои деревья" }),
  ).toBeVisible();
  await expect(page.getByText("Дерево семьи")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Войдите в Drevo" }),
  ).toHaveCount(0);
  await expect(page.locator('a[href="/a/other-archive/tree"]')).toBeVisible();

  await page.goto("/tree");
  await expect(page.getByRole("button", { name: "Личный кабинет" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Личный кабинет: Другой участник" })).toBeVisible();
});

test("signed-in account without a tree can download its account data", async ({ page }) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({ json: {
      user: null,
      account: { id: "account-only", name: "Пользователь", createdAt: "2026-10-01", fullAccess: false, provider: "email" },
      local: false,
      email: true,
      yandex: false,
      vk: false,
    } }),
  );
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/account/sessions", (route) =>
    route.fulfill({ json: { currentExpiresAt: null, otherCount: 0 } }),
  );
  await page.route("**/api/account/export", (route) =>
    route.fulfill({
      headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="drevo-account.json"' },
      body: JSON.stringify({ format: "drevo-account-data", account: { id: "account-only" }, archives: [] }),
    }),
  );
  await page.goto("/account");
  const link = page.getByRole("link", { name: "Скачать данные аккаунта" });
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/api/account/export");
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("drevo-account.json");
});
