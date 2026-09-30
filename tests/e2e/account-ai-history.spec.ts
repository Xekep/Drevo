import { expect, test } from "@playwright/test";

test("a basic account can remove old AI history from its account page", async ({ page }) => {
  const id = "14a064a7-6947-4089-9ad2-570b87978914";
  let chats = [{
    id,
    title: "Диалог с прежними правами доступа",
    updatedAt: "2026-09-30T12:00:00Z",
    unavailable: true,
  }];
  let deleted = false;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ status: 401, json: { error: "Private archive" } }),
  );
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: {
      id: "owner", name: "Участник", role: "admin", approved: true,
      createdAt: "2026-09-01", fullAccess: false, treeAccess: "all",
    },
    account: { id: "owner", name: "Участник", createdAt: "2026-09-01", fullAccess: false, provider: "yandex" },
    local: false, canEdit: true, yandex: true, vk: false,
  } }));
  await page.route("**/api/account/sessions", (route) =>
    route.fulfill({ json: { currentExpiresAt: null, otherCount: 0 } }),
  );
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/account/capacity", (route) =>
    route.fulfill({ json: { available: false } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats } }),
  );
  await page.route(`**/api/ai/chats/${id}`, (route) => {
    deleted = route.request().method() === "DELETE";
    chats = [];
    return route.fulfill({ json: { deleted: true } });
  });

  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Диалоги с ИИ" })).toBeVisible();
  await expect(page.getByText("Диалог с прежними правами доступа")).toBeVisible();
  await expect(page.getByText("Содержимое недоступно")).toBeVisible();
  await page.getByRole("button", { name: "Удалить диалог: Диалог с прежними правами доступа" }).click();
  await page.getByRole("button", { name: "Удалить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Диалоги с ИИ" })).toHaveCount(0);
  expect(deleted).toBe(true);
});
