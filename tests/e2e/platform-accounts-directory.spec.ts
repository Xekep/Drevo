import { expect, test, type Page } from "@playwright/test";

async function platformAdmin(page: Page) {
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    local: false, user: null, account: { id: "admin", name: "Администратор", globalRole: "admin", fullAccess: true },
  } }));
}
const row = (id: string, name: string) => ({ id, name, role: null, fullAccess: false, lastVisitAt: "2026-10-06T09:00:00Z" });

test("one directory searches and replaces AJAX pages, loading statistics only on click", async ({ page }, info) => {
  await platformAdmin(page);
  const requests: string[] = [];
  let statsReads = 0;
  await page.route("**/api/platform/accounts**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith("/statistics")) { statsReads++; return route.fulfill({ json: {
      accounts: 3, basic: 2, full: 1, admins: 1, researchers: 0,
    } }); }
    const query = url.searchParams.get("q");
    return route.fulfill({ json: query ? { accounts: query === "Нет такого" ? [] : [row("found", "Найденный пользователь")], next: null } :
      url.searchParams.has("after") ? { accounts: [row("second", "Пользователь второй страницы")], next: null } :
        { accounts: [row("first", "Александра Константиновна Петрова")], next: "fixture-page-2" } });
  });
  await page.goto("/admin");
  const list = page.getByRole("region", { name: "Пользователи", exact: true });
  await expect(list.getByLabel("Роль Александра Константиновна Петрова")).toBeVisible();
  expect(statsReads).toBe(0);
  await expect(page.getByRole("heading", { name: "Уровень доступа", exact: true })).toHaveCount(0);
  for (const width of info.project.name === "desktop" ? [1440, 1024, 768] : [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const layout = await list.locator(".platform-account-row").evaluate((element) => {
      const controls = [...element.querySelectorAll("select,button")].map((field) => field.getBoundingClientRect());
      return { fit: controls.every((field) => field.left >= 0 && field.right <= innerWidth + 1),
        separated: controls.every((field, index) => controls.slice(index + 1).every((other) =>
          field.right <= other.left || other.right <= field.left || field.bottom <= other.top || other.bottom <= field.top)),
        height: element.getBoundingClientRect().height };
    });
    expect(layout.fit).toBe(true); expect(layout.separated).toBe(true);
    expect(layout.height).toBeLessThan(width <= 600 ? 180 : 100);
    await page.screenshot({ path: info.outputPath(`accounts-directory-${width}.png`) });
  }
  await list.getByRole("button", { name: "Далее", exact: true }).click();
  await expect(list.getByText("Пользователь второй страницы", { exact: true })).toBeVisible();
  await expect(list.getByText("Александра Константиновна Петрова", { exact: true })).toHaveCount(0);
  await list.getByRole("button", { name: "Назад", exact: true }).click();
  await expect(list.getByLabel("Роль Александра Константиновна Петрова")).toBeVisible();
  await page.getByLabel("Поиск пользователей").fill("Найденный");
  await expect(list.getByText("Найденный пользователь", { exact: true })).toBeVisible();
  await expect(list.getByText("Страница 1", { exact: true })).toBeVisible();
  await page.getByLabel("Поиск пользователей").fill("Нет такого");
  await expect(list.getByText("Пользователи не найдены.")).toBeVisible();
  await page.getByLabel("Очистить поиск").click();
  await expect(list.getByLabel("Роль Александра Константиновна Петрова")).toBeVisible();
  await list.getByRole("button", { name: "Статистика", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Статистика пользователей" });
  await expect(dialog).toContainText("Всего пользователей");
  expect(statsReads).toBe(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(list.getByRole("button", { name: "Статистика", exact: true })).toBeFocused();
  expect(requests.some((path) => path.includes("after=fixture-page-2"))).toBe(true);
});

test("slow search cannot overwrite newer results and mutations keep role and tier independent", async ({ page }) => {
  await platformAdmin(page);
  let release: (() => Promise<void>) | null = null;
  let firstReached = false;
  const mutations: { path: string; body: unknown }[] = [];
  await page.route("**/api/platform/accounts**", (route) => {
    const query = new URL(route.request().url()).searchParams.get("q");
    if (query === "Старый") {
      firstReached = true;
      release = () => route.fulfill({ json: { accounts: [row("stale", "Устаревший результат")], next: null } }).catch(() => {});
      return;
    }
    return route.fulfill({ json: { accounts: [row("member", query === "Новый" ? "Новый результат" : "Пользователь")], next: null } });
  });
  await page.route(/\/api\/platform\/(roles|tiers)\/member$/, (route) => {
    const body = route.request().postDataJSON();
    const path = new URL(route.request().url()).pathname;
    mutations.push({ path, body });
    return route.fulfill({ json: path.includes("/roles/") ? { role: body.role } : { fullAccess: body.fullAccess } });
  });
  await page.goto("/admin");
  const input = page.getByLabel("Поиск пользователей");
  await input.fill("Старый");
  await expect.poll(() => firstReached).toBe(true);
  await input.fill("Новый");
  await expect(page.getByText("Новый результат", { exact: true })).toBeVisible();
  await release!();
  await expect(page.getByText("Устаревший результат", { exact: true })).toHaveCount(0);
  await page.getByLabel("Роль Новый результат").selectOption("researcher");
  await expect(page.getByLabel("Роль Новый результат")).toHaveValue("researcher");
  await expect(page.getByLabel("Уровень доступа Новый результат")).toHaveValue("basic");
  await page.getByLabel("Уровень доступа Новый результат").selectOption("full");
  await expect(page.getByLabel("Уровень доступа Новый результат")).toHaveValue("full");
  await expect(page.getByLabel("Роль Новый результат")).toHaveValue("researcher");
  expect(mutations).toEqual([
    { path: "/api/platform/roles/member", body: { role: "researcher" } },
    { path: "/api/platform/tiers/member", body: { fullAccess: true, expectedFullAccess: false } },
  ]);
});
