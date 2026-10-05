import { expect, test, type Page } from "@playwright/test";

test("platform header keeps the menu right aligned and loads only the linked portrait", async ({ page }, info) => {
  let familyRequests = 0;
  let portraitRequests = 0;
  await page.route("**/api/family?projection=overview", (route) => {
    familyRequests++;
    return route.fulfill({ status: 401, json: {} });
  });
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: { id: "admin", name: "Администратор", role: "reader", approved: true,
      personId: "self", platformAdmin: true },
    account: { id: "admin", name: "Администратор", globalRole: "admin" },
    local: false,
  } }));
  await page.route("**/api/account/portrait", (route) => {
    portraitRequests++;
    return route.fulfill({ json: { personId: "self", photo: "/media/admin-avatar.jpg" } });
  });
  await page.route("**/media/admin-avatar.jpg?variant=thumb", (route) => route.fulfill({
    contentType: "image/svg+xml",
    body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="#688a70"/></svg>',
  }));
  await page.route("**/api/platform/roles", (route) => route.fulfill({ json: { accounts: [], next: null } }));
  await page.goto("/admin");
  await expect(page.locator(".nav-account-avatar img")).toBeVisible();
  for (const width of [320, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const menu = page.locator(".archive-more");
    const bounds = (await menu.boundingBox())!;
    const padding = await page.locator(".archive-header").evaluate((header) => {
      const style = getComputedStyle(header);
      return { left: parseFloat(style.paddingLeft), right: parseFloat(style.paddingRight) };
    });
    expect(width - bounds.x - bounds.width).toBeCloseTo(padding.right, 0);
    const brand = (await page.locator(".nav-brand").boundingBox())!;
    expect(brand.x).toBeCloseTo(padding.left, 0);
    await page.getByLabel("Меню проекта").click();
    await expect(menu.locator(".nav-bottom")).toBeVisible();
    const popup = (await menu.locator(".nav-bottom").boundingBox())!;
    expect(popup.x).toBeGreaterThanOrEqual(0);
    expect(popup.x + popup.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: info.outputPath(`platform-header-${width}.png`) });
    await page.keyboard.press("Escape");
  }
  expect(familyRequests).toBe(0);
  expect(portraitRequests).toBe(1);
});

async function treeUser(page: Page, options: {
  owner: boolean; platformAdmin: boolean; fullAccess?: boolean; approved?: boolean;
}) {
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: { id: "fixture-user", name: "Участник", role: options.owner ? "admin" : "reader",
      archiveOwner: options.owner, approved: options.approved ?? true,
      platformAdmin: options.platformAdmin, fullAccess: options.fullAccess ?? true },
    account: { id: "fixture-user", name: "Участник", createdAt: "2026-10-04",
      fullAccess: options.fullAccess ?? true, globalRole: options.platformAdmin ? "admin" : null,
      provider: "email" }, local: false, yandex: false,
  } }));
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch({
      url: route.request().url().replace("/a/tree-a/api/", "/api/"),
    });
    const data = await response.json();
    await route.fulfill({ response, json: {
      ...data, local: false,
      user: { ...data.user, role: options.owner ? "admin" : "reader",
        archiveOwner: options.owner, approved: options.approved ?? true,
        fullAccess: options.fullAccess ?? true,
        platformAdmin: options.platformAdmin,
      },
    } });
  });
}

test("tree owner reaches scoped management from the avatar menu, and old scoped admin URL becomes manage", async ({ page }, info) => {
  await page.route("**/a/tree-a/api/**", (route) => route.continue({
    url: route.request().url().replace("/a/tree-a/api/", "/api/"),
  }));
  await treeUser(page, { owner: true, platformAdmin: false, fullAccess: false });
  await page.goto("/a/tree-a/tree");
  await page.getByLabel("Меню проекта").click();
  const manage = page.locator(".nav-menu-manage");
  await expect(manage).toHaveAttribute("href", "/a/tree-a/manage");
  await expect(page.locator(".nav-bottom").getByRole("button", { name: "Выйти" })).toBeVisible();
  await manage.click();
  await expect(page).toHaveURL(/\/a\/tree-a\/manage$/);
  await expect(page.getByRole("heading", { name: "Участники", exact: true })).toBeVisible();
  if (info.project.name === "desktop") {
    for (const width of [1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: info.outputPath(`tree-manage-${width}.png`), fullPage: true });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    }
  }
  await expect(page.getByRole("link", { name: "Админка платформы" })).toHaveCount(0);
  await page.goto("/a/tree-a/admin?section=storage");
  await expect(page).toHaveURL(/\/a\/tree-a\/manage$/);
  await expect(page.getByRole("heading", { name: "Участники", exact: true })).toBeVisible();
  await page.goto("/a/tree-a/admin/matches");
  await expect(page).toHaveURL(/\/a\/tree-a\/manage\/matches$/);
  await page.goto("/admin/matches");
  await expect(page).toHaveURL(/\/manage\/matches$/);
  await expect(page.getByRole("heading", { name: "Связи древ" })).toBeVisible();
});

test("gear opens only owner management; full tier does not grant platform settings", async ({ page }) => {
  await treeUser(page, { owner: true, platformAdmin: false, fullAccess: true });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await page.getByRole("dialog", { name: "Вид древа" })
    .getByRole("button", { name: "Управление древом" }).click();
  await expect(page).toHaveURL(/\/manage$/);
  for (const label of ["Yandex AI", "Хранилище", "Вход через VK", "Ресурсы поиска"])
    await expect(page.locator(".admin-sidebar nav").getByRole("button", { name: label })).toHaveCount(0);
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Админка платформы" })).toBeVisible();
  await expect(page.getByText("Доступна только администратору платформы.")).toBeVisible();
});

test("global admin without membership opens /admin without requesting a private family", async ({ page }) => {
  let familyRequests = 0;
  await page.route("**/api/family?projection=overview", (route) => {
    familyRequests++;
    return route.fulfill({ status: 401, json: { error: "Private archive" } });
  });
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: null,
    account: { id: "platform-only", name: "Администратор платформы", createdAt: "2026-10-04",
      fullAccess: false, globalRole: "admin", provider: "email" },
    local: false, yandex: false, email: true,
  } }));
  await page.route("**/api/platform/roles", (route) => route.fulfill({ json: { accounts: [], next: null } }));
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Админка платформы" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Глобальные роли" })).toBeVisible();
  expect(familyRequests).toBe(0);
  await page.getByLabel("Меню проекта").click();
  await expect(page.locator(".nav-menu-account")).toHaveAttribute("href", "/account");
  await expect(page.locator(".nav-menu-platform")).toHaveAttribute("href", "/admin");
  await expect(page.locator(".nav-menu-manage")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Управление древом" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Резервные копии", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "MCP-токены", exact: true })).toBeVisible();
});

test("legacy local platform admin uses the trusted session flag without an account profile", async ({ page }) => {
  let familyRequests = 0;
  await page.route("**/api/family?projection=overview", (route) => {
    familyRequests++;
    return route.fulfill({ status: 401, json: { error: "Private archive" } });
  });
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: { id: "local-admin", name: "Локальный администратор", role: "admin",
      platformAdmin: true, approved: true, fullAccess: true },
    account: null, local: true, yandex: false,
  } }));
  await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [] } }));
  await page.route("**/api/admin/ai", (route) => route.fulfill({ status: 503, json: { error: "Тест" } }));
  await page.goto("/admin");
  await expect(page.getByRole("heading", { name: "Админка платформы" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Yandex AI" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Глобальные роли" })).toHaveCount(0);
  expect(familyRequests).toBe(0);
});

test("global admin with reader membership has platform entry but no owner controls", async ({ page }) => {
  await treeUser(page, { owner: false, platformAdmin: true });
  await page.goto("/tree");
  await page.getByLabel("Меню проекта").click();
  await expect(page.locator(".nav-menu-platform")).toHaveAttribute("href", "/admin");
  await expect(page.locator(".nav-menu-manage")).toHaveCount(0);
  await page.getByLabel("Меню проекта").click();
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await expect(page.getByRole("dialog", { name: "Вид древа" })
    .getByRole("button", { name: "Управление древом" })).toHaveCount(0);
  await page.goto("/manage");
  await expect(page.getByText("Панель доступна администратору.")).toBeVisible();
});

test("combined owner and global admin get two avatar entries and native Back restores the scoped tree", async ({ page }) => {
  await page.route("**/a/tree-a/api/**", (route) => route.continue({
    url: route.request().url().replace("/a/tree-a/api/", "/api/"),
  }));
  await treeUser(page, { owner: true, platformAdmin: true });
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: null, account: { id: "platform-owner", name: "Администратор", createdAt: "2026-10-04",
      fullAccess: true, globalRole: "admin", provider: "email" }, local: false, yandex: false,
  } }));
  await page.goto("/a/tree-a/tree");
  await page.getByLabel("Меню проекта").click();
  const platform = page.locator(".nav-menu-platform");
  await expect(platform).toHaveAttribute("href", "/admin");
  await expect(page.locator(".nav-menu-manage"))
    .toHaveAttribute("href", "/a/tree-a/manage");
  await platform.click();
  await expect(page).toHaveURL(/\/admin$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/a\/tree-a\/tree$/);
});
