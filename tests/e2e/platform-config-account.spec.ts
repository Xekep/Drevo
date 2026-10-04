import { expect, test } from "@playwright/test";

test("platform admin without a tree reaches common settings from the account page", async ({ page }) => {
  const paths: string[] = [];
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ status: 401, json: { error: "Private archive" } }));
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: null,
    account: { id: "platform-only", name: "Администратор платформы",
      createdAt: "2026-10-04", fullAccess: false, globalRole: "admin",
      provider: "email" },
    local: false, yandex: false, vk: false, email: true,
  } }));
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives: [] } }));
  await page.route("**/api/account/sessions", (route) =>
    route.fulfill({ json: { currentExpiresAt: null, otherCount: 0 } }));
  await page.route("**/api/platform/roles", (route) =>
    route.fulfill({ json: { accounts: [], next: null } }));
  await page.route("**/api/admin/ai", (route) =>
    route.fulfill({ status: 503, json: { error: "Тестовая модель отключена" } }));
  await page.route("**/api/settings/storage", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: {
      admin: 100, researcher: 50, relative: 10, reader: 1,
    } });
  });
  await page.route("**/api/admin/auth/vk", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: {
      enabled: false, clientId: "", available: false, callbackUrl: "",
    } });
  });
  await page.route("**/api/admin/research-resources", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { categories: [] } });
  });

  await page.goto("/account");
  for (const label of ["Лимиты хранилища", "Вход через VK", "Ресурсы поиска"])
    await expect(page.getByRole("heading", { name: label })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Глобальные роли" })).toBeVisible();
  await expect(page.getByText("MCP-токены", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Резервные копии", { exact: true })).toHaveCount(0);
  await expect.poll(() => paths.length).toBe(3);
  expect(paths.sort()).toEqual([
    "/api/admin/auth/vk", "/api/admin/research-resources", "/api/settings/storage",
  ]);
});
