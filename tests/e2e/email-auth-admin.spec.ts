import { expect, test } from "@playwright/test";

test("platform email settings keep the secret out of the form and fit mobile", async ({ page }, info) => {
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    user: null, account: { id: "admin", name: "Администратор", globalRole: "admin",
      fullAccess: true, provider: "yandex", createdAt: "2026-01-01" },
    local: false, email: false, yandex: true, vk: false,
  } }));
  await page.route("**/api/platform/accounts", (route) => route.fulfill({ json: { accounts: [], next: null } }));
  await page.route("**/api/platform/tiers", (route) => route.fulfill({ json: {
    accounts: [], next: null, totals: { basic: 0, full: 0 },
  } }));
  let settings = { enabled: false, host: "smtp.example.org", port: 587, user: "smtp-user",
    from: "mail@example.org", hasPassword: true, available: false, supported: true,
    origin: "https://mydrevo.org" };
  const writes: Record<string, unknown>[] = [];
  await page.route("**/api/admin/auth/email", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON(); writes.push(body);
      settings = { ...settings, enabled: body.enabled, host: body.host, port: body.port,
        user: body.user, from: body.from, available: body.enabled };
    }
    await route.fulfill({ json: settings });
  });
  await page.route("**/api/admin/auth/email/test", async (route) => {
    expect(route.request().postDataJSON()).toEqual({ to: "test@example.org" });
    await route.fulfill({ json: { message: "SMTP принял письмо. Проверьте его получение." } });
  });
  await page.goto("/admin");
  await page.getByRole("navigation", { name: "Разделы админки платформы" })
    .getByRole("button", { name: "Вход по email" }).click();
  const form = page.getByRole("region", { name: "Настройки входа по email" });
  await expect(form.getByLabel("Пароль SMTP", { exact: true })).toHaveValue("");
  await expect(form.getByRole("button", { name: "Сохранить", exact: true })).toBeDisabled();
  for (const width of info.project.name === "desktop" ? [1440, 768] : [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    const fits = await form.evaluate((element) => [...element.querySelectorAll("input:not([type=checkbox]), button")]
      .every((field) => { const r = field.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1; }));
    expect(fits).toBe(true);
    await page.screenshot({ path: info.outputPath(`email-settings-${width}.png`) });
  }
  await form.getByLabel("Вход и регистрация по email").check();
  await expect(form.getByRole("button", { name: "Отправить тест" })).toBeDisabled();
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form.getByRole("status")).toContainText("Вход по email включён");
  expect(writes[0]).not.toHaveProperty("password");
  await form.getByLabel("Пароль SMTP", { exact: true }).fill("replacement-fixture-password");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(form.getByLabel("Пароль SMTP", { exact: true })).toHaveValue("");
  expect(writes[1]).toHaveProperty("password", "replacement-fixture-password");
  await form.getByLabel("Тестовое письмо", { exact: true }).fill("test@example.org");
  await form.getByRole("button", { name: "Отправить тест" }).click();
  await expect(form.getByRole("status")).toContainText("SMTP принял письмо");
});
