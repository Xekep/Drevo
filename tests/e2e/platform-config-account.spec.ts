import { expect, test } from "@playwright/test";

test("platform admin without membership opens global settings, with archive-scoped AI selection", async ({ page }, info) => {
  const paths: string[] = [];
  let familyRequests = 0;
  let includeSecondary = true;
  let ownFullAccess = false;
  await page.route("**/api/family?projection=overview", (route) => {
    familyRequests++;
    return route.fulfill({ status: 401, json: { error: "Private archive" } });
  });
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: null,
    account: { id: "platform-only", name: "Администратор платформы",
      createdAt: "2026-10-04", fullAccess: ownFullAccess, globalRole: "admin", provider: "email" },
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
  let fullAccess = false;
  let rejectTierChange = true;
  await page.route(/\/api\/platform\/tiers(?:\/[^/?]+)?(?:\?.*)?$/, async (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        expectedFullAccess: boolean; fullAccess: boolean };
      const own = new URL(route.request().url()).pathname.endsWith("/platform-only");
      expect(body.expectedFullAccess).toBe(own ? ownFullAccess : fullAccess);
      if (!own && rejectTierChange) {
        rejectTierChange = false;
        fullAccess = true; // Another platform admin committed first.
        return route.fulfill({ status: 409, json: { error: "Уровень изменился. Обновите список" } });
      }
      if (own) ownFullAccess = body.fullAccess;
      else fullAccess = body.fullAccess;
      return route.fulfill({ json: { accountId: own ? "platform-only" : "new-account",
        fullAccess: body.fullAccess, changed: true } });
    }
    const detail = /^\/api\/platform\/tiers\/(new-account|platform-only)$/.exec(
      new URL(route.request().url()).pathname);
    if (detail) return route.fulfill({ json: {
      accountId: detail[1], fullAccess: detail[1] === "platform-only" ? ownFullAccess : fullAccess,
    } });
    return route.fulfill({ json: { accounts: [
      { id: "new-account", name: "Новый владелец", fullAccess },
      { id: "platform-only", name: "Администратор платформы", fullAccess: ownFullAccess },
    ], next: null, totals: { basic: Number(!fullAccess) + Number(!ownFullAccess),
      full: Number(fullAccess) + Number(ownFullAccess) } } });
  });
  await page.route(/\/api\/platform\/tiers\/new-account\/usage$/, (route) =>
    route.fulfill({ json: { accountId: "new-account", owned: true,
      people: 12, mediaBytes: 20_000_000 } }));
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
  await expect(page.getByRole("link", { name: "Управление древом" })).toHaveCount(0);
  await page.getByRole("button", { name: "Админка платформы" }).click();
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.getByRole("heading", { name: "Админка платформы" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Глобальные роли" })).toBeVisible();
  const tier = page.getByLabel("Уровень доступа Новый владелец");
  await expect(tier).toHaveValue("basic");
  await tier.selectOption("full");
  await expect(page.getByRole("alert")).toContainText("Уровень изменился");
  await expect(tier).toHaveValue("full");
  await page.getByRole("button", { name: "Обновить список" }).click();
  await expect(tier).toHaveValue("full");
  await tier.selectOption("basic");
  await expect(tier).toHaveValue("basic");
  await expect(page.getByLabel("Сводка уровней доступа")).toContainText("Полный: 0");
  await page.locator(".account-tier-entry").filter({ hasText: "Новый владелец" })
    .getByRole("button", { name: "Расход" }).click();
  await expect(page.getByText(/Людей: 12; файлы: 20 МБ/)).toBeVisible();
  await page.getByLabel("Уровень доступа Администратор платформы").selectOption("full");
  await expect(page.getByLabel("Сводка уровней доступа")).toContainText("Полный: 1");
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
  await expect(page.getByRole("button", { name: "MCP-токены", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Резервные копии", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "MCP-токены", exact: true }).click();
  await expect(page.getByText("Нет доступных архивов для этой операции.")).toBeVisible();
  expect(familyRequests).toBe(beforePlatform);
});

test("own tier downgrade and upgrade refresh the locked session without a family reload", async ({ page }) => {
  let fullAccess = true;
  let familyReads = 0;
  const sessionAvailability: boolean[] = [];
  await page.route("**/api/session", (route) => {
    sessionAvailability.push(fullAccess);
    return route.fulfill({ json: {
      user: { id: "owner", name: "Владелец", role: "relative", treeRole: "relative",
        archiveOwner: true, approved: true, platformAdmin: true, globalRole: "admin",
        fullAccess, aiAvailable: fullAccess },
      account: { id: "owner", name: "Владелец", createdAt: "2026-10-04",
        fullAccess, globalRole: "admin", provider: "email" },
      local: false, yandex: false, vk: false, email: true,
    } });
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    familyReads++;
    const response = await route.fetch();
    const data = await response.json();
    return route.fulfill({ response, json: { ...data, local: false,
      user: { ...data.user, id: "owner", name: "Владелец", role: "relative",
        treeRole: "relative", archiveOwner: true, approved: true,
        platformAdmin: true, globalRole: "admin", fullAccess: true,
        aiAvailable: true },
    } });
  });
  await page.route("**/api/platform/roles", (route) => route.fulfill({ json: {
    accounts: [], next: null,
  } }));
  await page.route(/\/api\/platform\/tiers(?:\/owner)?$/, (route) => {
    if (route.request().method() === "PATCH") {
      const body = route.request().postDataJSON() as {
        expectedFullAccess: boolean; fullAccess: boolean };
      expect(body.expectedFullAccess).toBe(fullAccess);
      fullAccess = body.fullAccess;
      return route.fulfill({ json: { accountId: "owner", fullAccess, changed: true } });
    }
    if (new URL(route.request().url()).pathname.endsWith("/owner"))
      return route.fulfill({ json: { accountId: "owner", fullAccess } });
    return route.fulfill({ json: { accounts: [
      { id: "owner", name: "Владелец", fullAccess },
    ], next: null, totals: { basic: Number(!fullAccess), full: Number(fullAccess) } } });
  });
  await page.goto("/admin");
  const tier = page.getByLabel("Уровень доступа Владелец");
  await expect(tier).toHaveValue("full");
  const initialFamilyReads = familyReads;
  const initialSessionReads = sessionAvailability.length;
  await tier.selectOption("basic");
  await expect(tier).toHaveValue("basic");
  await expect.poll(() => sessionAvailability.length).toBeGreaterThan(initialSessionReads);
  await expect.poll(() => sessionAvailability.at(-1)).toBe(false);
  await tier.selectOption("full");
  await expect(tier).toHaveValue("full");
  await expect.poll(() => sessionAvailability.at(-1)).toBe(true);
  expect(familyReads).toBe(initialFamilyReads);
});
