import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, email: true } });
  });
});

test("email login and registration remain compact on desktop and mobile", async ({
  page,
}) => {
  await page.goto("/account#email-verify=" + "a".repeat(43));
  await expect(
    page.getByRole("heading", { name: "Подтвердить почту" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Подтвердить" })).toBeVisible();
  await page.getByRole("button", { name: "Создать аккаунт" }).click();
  await expect(
    page.getByRole("heading", { name: "Создать личное древо" }),
  ).toBeVisible();
  await expect(page.getByLabel("Имя")).toBeVisible();
  await expect(page.getByLabel("Почта")).toBeVisible();
  await expect(page.getByLabel("Пароль")).toBeVisible();
  const bounds = await page.locator(".login-email-form").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});

test("an email-link token opens explicit confirmation", async ({ page }) => {
  await page.goto("/account#email-link=" + "b".repeat(43));
  await expect(
    page.getByRole("heading", { name: "Подключить почту" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Подключить почту" }),
  ).toBeVisible();
});

test("account can request an additional email login without widening the form", async ({ page }) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: {
      ...data,
      local: false,
      email: true,
      account: { id: "oauth-probe", name: "Проверка", createdAt: "2026-09-30", fullAccess: false, provider: "yandex", providers: ["yandex"] },
    } });
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Подключить вход по почте" }).click();
  await expect(page.getByLabel("Новый пароль")).toBeVisible();
  const bounds = await page.locator(".account-email-link form").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});
