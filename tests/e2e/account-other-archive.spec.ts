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
  await page.getByLabel("Меню проекта").click();
  await expect(page.locator(".nav-menu-account")).toHaveAttribute("href", "/account");
  await expect(page.locator(".nav-account")).toHaveAttribute("title", "Меню: Другой участник");
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
  await expect(page.getByText(/свои текущие комментарии в доступных частях деревьев/)).toBeVisible();
  await expect(page.getByText(/Тексты из закрытых ветвей и архивов без действующего доступа/)).toBeVisible();
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute("href", "/api/account/export");
  await expect(page.getByRole("link", { name: "Скачать свои вложения обсуждений и ИИ-диалогов" }))
    .toHaveAttribute("href", "/api/account/export/attachments");
  const download = page.waitForEvent("download");
  await link.click();
  expect((await download).suggestedFilename()).toBe("drevo-account.json");
});

test("account shows and revokes one other session without leaving the page", async ({ page }) => {
  const currentId = "11111111-1111-4111-8111-111111111111";
  const otherId = "22222222-2222-4222-8222-222222222222";
  let revoked = false;
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: null,
    account: { id: "session-owner", name: "Участник", createdAt: "2026-10-01", fullAccess: false, provider: "yandex" },
    local: false, yandex: true, vk: false,
  } }));
  await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [] } }));
  await page.route("**/api/account/sessions", (route) => route.fulfill({ json: {
    currentExpiresAt: "2026-12-31T00:00:00.000Z",
    otherCount: revoked ? 0 : 1,
    items: [
      { id: currentId, isCurrent: true, createdAt: "2026-10-02T10:00:00.000Z", expiresAt: "2026-12-31T00:00:00.000Z" },
      ...(revoked ? [] : [{ id: otherId, isCurrent: false, createdAt: null, expiresAt: "2026-12-31T00:00:00.000Z" }]),
    ],
  } }));
  await page.route(`**/api/account/sessions/${otherId}/revoke`, (route) => {
    revoked = true;
    return route.fulfill({ json: { revoked: true } });
  });
  await page.goto("/account");
  await expect(page.locator(".account-session-list").getByText("Этот сеанс")).toBeVisible();
  await expect(page.locator(".account-session-list").getByText("Дата входа неизвестна")).toBeVisible();
  await page.locator(".account-session-item").filter({ hasText: "Другой сеанс" })
    .getByRole("button", { name: "Завершить" }).click();
  await expect(page.locator(".account-session-list").getByText("Другой сеанс")).toHaveCount(0);
  expect(revoked).toBe(true);
  const bounds = await page.locator(".account-session-list").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
