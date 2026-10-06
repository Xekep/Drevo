import { expect, test } from "@playwright/test";

test("platform sections stay reachable and forms fit desktop and mobile screens", async ({ page }, info) => {
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: null, account: { id: "admin", name: "Администратор", globalRole: "admin",
      fullAccess: true, provider: "email", createdAt: "2026-01-01" },
    local: false, email: true, yandex: false, vk: false,
  } }));
  await page.route("**/api/platform/roles", (route) => route.fulfill({ json: {
    accounts: [{ id: "member", name: "Александра Константиновна Петрова", role: "researcher" }], next: null,
  } }));
  await page.route("**/api/platform/tiers", (route) => route.fulfill({ json: {
    accounts: [{ id: "member", name: "Александра Константиновна Петрова", fullAccess: true }],
    next: null, totals: { basic: 0, full: 1 },
  } }));
  await page.route("**/api/admin/research-resources", (route) => route.fulfill({ json: { categories: [] } }));
  await page.goto("/admin");
  const navigation = page.getByRole("navigation", { name: "Разделы админки платформы" });
  await expect(page.getByRole("heading", { name: "Глобальные роли", exact: true })).toBeVisible();
  for (const width of info.project.name === "desktop" ? [1440, 1024, 768] : [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const bounds = await page.getByLabel("Роль Александра Константиновна Петрова").boundingBox();
    expect(bounds!.width).toBeGreaterThan(100);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath(`platform-roles-${width}.png`) });
  }
  const resources = navigation.getByRole("button", { name: "Ресурсы поиска" });
  await resources.click();
  await expect(resources).toHaveAttribute("aria-current", "page");
  const selected = await resources.boundingBox();
  const nav = await navigation.boundingBox();
  expect(selected!.x).toBeGreaterThanOrEqual(nav!.x - 1);
  expect(selected!.x + selected!.width).toBeLessThanOrEqual(nav!.x + nav!.width + 1);
  await expect(page.getByRole("heading", { name: "Ресурсы поиска", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Вернуться в профиль" }).click();
  await expect(page).toHaveURL(/\/account$/);
});

test("participant controls remain distinct and compact without hiding role guidance", async ({ page }, info) => {
  await page.route("**/api/users?**", (route) => route.fulfill({ json: {
    users: [{ id: "member", name: "Александра Константиновна Петрова", role: "reader", treeRole: "reader",
      approved: true, personId: "e2e-child", treeAccess: "common_ancestors", createdAt: "2026-01-01" }],
    total: 1, next: null,
  } }));
  await page.goto("/manage");
  const row = page.getByRole("article", { name: "Участник: Александра Константиновна Петрова", exact: true });
  await expect(row).toBeVisible();
  const guidance = page.locator(".admin-access-help");
  await expect(guidance).not.toHaveAttribute("open", "");
  await guidance.getByText("Как работают роли и доступ").click();
  await expect(guidance).toContainText("Новые пользователи ожидают одобрения");
  await guidance.getByText("Как работают роли и доступ").click();
  for (const width of info.project.name === "desktop" ? [1440, 1024, 768] : [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await row.evaluate((element) => {
      const row = element.getBoundingClientRect();
      const fields = [...element.querySelectorAll("select, input")].map((field) => field.getBoundingClientRect());
      return { height: row.height, overflow: document.documentElement.scrollWidth - innerWidth,
        contained: fields.every((field) => field.left >= row.left - 1 && field.right <= row.right + 1),
        separate: fields.every((field, index) => fields.slice(index + 1).every((other) =>
          field.right <= other.left + 1 || other.right <= field.left + 1 ||
          field.bottom <= other.top + 1 || other.bottom <= field.top + 1)),
        minHeight: Math.min(...fields.map((field) => field.height)) };
    });
    expect(layout.overflow).toBeLessThanOrEqual(1);
    expect(layout.contained).toBe(true);
    expect(layout.separate).toBe(true);
    expect(layout.minHeight).toBeGreaterThanOrEqual(width <= 600 ? 44 : 36);
    if (width <= 390) expect(layout.height).toBeLessThan(410);
    if (width <= 1024) {
      const person = await row.getByLabel("Кто это в древе: Александра Константиновна Петрова").boundingBox();
      expect(person!.width).toBeGreaterThan(width <= 390 ? 150 : 190);
      const scope = await row.getByLabel("Доступ к древу: Александра Константиновна Петрова").boundingBox();
      expect(scope!.width).toBeGreaterThan(190);
    }
    await page.screenshot({ path: info.outputPath(`tree-participants-${width}.png`) });
  }
});
