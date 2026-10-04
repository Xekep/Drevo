import { expect, test } from "@playwright/test";

test("platform admin without membership opens global settings, with archive-scoped AI selection", async ({ page }, info) => {
  const paths: string[] = [];
  let familyRequests = 0;
  let includeSecondary = true;
  await page.route("**/api/family?projection=overview", (route) => {
    familyRequests++;
    return route.fulfill({ status: 401, json: { error: "Private archive" } });
  });
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: null,
    account: { id: "platform-only", name: "Администратор платформы",
      createdAt: "2026-10-04", fullAccess: false, globalRole: "admin", provider: "email" },
    local: false, yandex: false, vk: false, email: true,
  } }));
  await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [
    { id: "primary-tree", title: "Основной архив", approved: true, current: true },
    ...(includeSecondary ? [{ id: "other-tree", title: "Другое дерево", approved: true, current: false }] : []),
    { id: "hidden-tree", title: "Закрытое дерево", approved: false, current: false },
  ] } }));
  await page.route("**/api/account/sessions", (route) => route.fulfill({ json: {
    currentExpiresAt: null, otherCount: 0,
  } }));
  await page.route("**/api/platform/roles", (route) => route.fulfill({ json: {
    accounts: [
      { id: "staff-1", name: "Александра Петрова", role: "researcher" },
      { id: "staff-2", name: "Константин Александров", role: "admin" },
    ], next: null,
  } }));
  await page.route("**/api/admin/ai", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ status: 503, json: { error: "Тестовая модель отключена" } });
  });
  await page.route("**/api/settings/storage", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { admin: 100, researcher: 50, relative: 10, reader: 1 } });
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
  await expect(page.getByRole("heading", { name: "Глобальные роли" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Управление деревом" })).toHaveCount(0);
  await page.getByRole("button", { name: "Админка платформы" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Админка платформы" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Глобальные роли" })).toBeVisible();
  if (info.project.name === "mobile") {
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: info.outputPath(`platform-admin-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  }
  const beforePlatform = familyRequests;
  await page.getByRole("button", { name: "Хранилище" }).click();
  await expect(page.getByRole("heading", { name: "Лимиты хранилища" })).toBeVisible();
  await page.getByRole("button", { name: "Вход через VK" }).click();
  await page.getByRole("button", { name: "Ресурсы поиска" }).click();
  await page.getByRole("button", { name: "Yandex AI" }).click();
  const aiArchive = page.getByLabel("Архив для Yandex AI");
  await expect(aiArchive.getByRole("option")).toHaveText(["Основной архив", "Другое дерево"]);
  await expect.poll(() => paths.filter((path) => path === "/api/admin/ai").length).toBe(1);
  await aiArchive.selectOption("other-tree");
  await expect.poll(() => paths.filter((path) => path === "/a/other-tree/api/admin/ai").length).toBe(1);
  includeSecondary = false;
  await page.getByRole("button", { name: "Хранилище" }).click();
  await page.getByRole("button", { name: "Yandex AI" }).click();
  await expect(aiArchive).toHaveValue("");
  await expect(aiArchive.getByRole("option")).toHaveText(["Основной архив"]);
  await expect.poll(() => paths.filter((path) => path === "/api/admin/ai").length).toBe(2);
  await expect(page.getByText("Настройки ИИ задаются отдельно для выбранного архива.")).toBeVisible();
  expect(familyRequests).toBe(beforePlatform);
  for (const path of ["/api/settings/storage", "/api/admin/auth/vk", "/api/admin/research-resources"])
    expect(paths).toContain(path);
  await expect(page.getByText("MCP-токены", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Резервные копии", { exact: true })).toHaveCount(0);
});
