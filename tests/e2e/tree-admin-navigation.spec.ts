import { expect, test, type Page } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

async function accountView(page: Page, options: {
  approved?: boolean;
  fullAccess: boolean;
  platformAdmin: boolean;
  aiAvailable?: boolean;
}) {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        local: false,
        user: {
          ...data.user,
          role: "admin",
          approved: options.approved ?? true,
          fullAccess: options.fullAccess,
          aiAvailable: options.aiAvailable ?? options.fullAccess,
          platformAdmin: options.platformAdmin,
        },
      },
    });
  });
}

test("basic owner reaches tree management from the gear without platform or AI sections", async ({ page }) => {
  await accountView(page, { fullAccess: false, platformAdmin: false });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog.getByRole("button", { name: "Управление деревом" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(dialog).toHaveCount(0);
  const navigation = page.locator(".admin-sidebar nav");
  await expect(navigation.locator("button", { hasText: "Источники" })).toBeAttached();
  await expect(navigation.locator("button", { hasText: "Вход через VK" })).toBeAttached();
  await expect(navigation.locator("button", { hasText: "Хранилище" })).toBeAttached();
  for (const label of ["Yandex AI", "Ресурсы поиска", "MCP-токены", "Резервные копии"]) {
    await expect(navigation.locator("button", { hasText: label })).toHaveCount(0);
    await expect(page.locator("#admin-section-select").getByRole("option", { name: label })).toHaveCount(0);
  }
  await expect(page.locator("#admin-section-select optgroup[label='Платформа']")).toHaveCount(0);
  await expect(page.locator("#admin-section-select optgroup[label='ИИ и поиск']")).toHaveCount(0);

  await page.goto("/admin?section=ai");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
  await expect(page.getByText("Yandex AI", { exact: true })).toHaveCount(0);
  await page.goto("/admin?section=unknown");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
});

test("full owner keeps archive AI tools, while platform settings stay hidden", async ({ page }) => {
  await accountView(page, { fullAccess: true, platformAdmin: false });
  await page.goto("/admin");
  const navigation = page.locator(".admin-sidebar nav");
  for (const label of ["Ресурсы поиска", "MCP-токены"]) {
    await expect(navigation.locator("button", { hasText: label })).toBeAttached();
  }
  await expect(navigation.locator("button", { hasText: "Yandex AI" })).toHaveCount(0);
  await expect(page.locator("#admin-section-select").getByRole("option", { name: "Yandex AI" })).toHaveCount(0);
  await expect(navigation.locator("button", { hasText: "Резервные копии" })).toHaveCount(0);
  await expect(page.locator("#admin-section-select optgroup[label='Платформа']")).toHaveCount(0);
  await page.goto("/admin?section=ai");
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Участники" })).toBeVisible();
});

test("platform admin gets AI settings even without the archive AI feature tier", async ({ page }) => {
  await accountView(page, { fullAccess: false, platformAdmin: true });
  await page.goto("/admin");
  const navigation = page.locator(".admin-sidebar nav");
  await expect(navigation.locator(".admin-nav-label", { hasText: "Платформа" })).toBeAttached();
  await expect(navigation.locator("button", { hasText: "Yandex AI" })).toBeAttached();
  await expect(navigation.locator("button", { hasText: "Резервные копии" })).toBeAttached();
  await expect(page.locator("#admin-section-select optgroup[label='Платформа'] option")).toHaveText(["Yandex AI", "Резервные копии"]);
  await expect(navigation.locator("button", { hasText: "MCP-токены" })).toHaveCount(0);
  await openAdminSection(page, "ai", "Yandex AI");
  await expect(page.locator(".admin-page-header .section-label")).toHaveText("УПРАВЛЕНИЕ ПЛАТФОРМОЙ");
  await openAdminSection(page, "backups", "Резервные копии");
  await expect(page.locator(".admin-page-header .section-label")).toHaveText("УПРАВЛЕНИЕ ПЛАТФОРМОЙ");
});

test("full-tier invited admin cannot see AI tools while the tree owner is basic", async ({ page }) => {
  await accountView(page, { fullAccess: true, platformAdmin: false, aiAvailable: false });
  await page.goto("/admin");
  await expect(page.locator(".admin-sidebar nav button", { hasText: "Yandex AI" })).toHaveCount(0);
  await expect(page.locator("#admin-section-select option", { hasText: "MCP-токены" })).toHaveCount(0);
  await expect(page.locator(".admin-sidebar nav button", { hasText: "Источники" })).toBeAttached();
});

test("unapproved admin has no gear shortcut", async ({ page }) => {
  await accountView(page, { approved: false, fullAccess: false, platformAdmin: false });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await expect(page.getByRole("dialog", { name: "Вид древа" }).getByRole("button", { name: "Управление деревом" })).toHaveCount(0);
});

test("gear keeps the current tree's archive scope", async ({ page }) => {
  await page.route("**/a/tree-a/api/**", (route) => route.continue({
    url: route.request().url().replace("/a/tree-a/api/", "/api/"),
  }));
  await page.goto("/a/tree-a/tree");
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await page.getByRole("dialog", { name: "Вид древа" })
    .getByRole("button", { name: "Управление деревом" }).click();
  await expect(page).toHaveURL(/\/a\/tree-a\/admin$/);
});
