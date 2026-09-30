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
