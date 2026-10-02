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

test("email login without a tree opens the account to create one", async ({
  page,
}) => {
  let signedIn = false;
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        email: true,
        local: false,
        user: null,
        account: signedIn
          ? {
              id: "email-probe",
              name: "Почтовый участник",
              createdAt: "2026-10-01",
              fullAccess: false,
              provider: "email",
              providers: ["email"],
            }
          : null,
      },
    });
  });
  await page.route("**/api/auth/email/login", (route) => {
    signedIn = true;
    return route.fulfill({
      status: 200,
      json: { archiveId: null, account: true },
    });
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Войти по почте" }).click();
  await page.getByLabel("Почта").fill("person@example.org");
  await page.getByLabel("Пароль").fill("correct horse battery staple");
  await page
    .locator(".login-email-form")
    .getByRole("button", { name: "Войти", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Почтовый участник" }),
  ).toBeVisible();
});

test("account can request an additional email login without widening the form", async ({
  page,
}) => {
  await page.route("**/api/session", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        local: false,
        email: true,
        account: {
          id: "oauth-probe",
          name: "Проверка",
          createdAt: "2026-09-30",
          fullAccess: false,
          provider: "yandex",
          providers: ["yandex"],
        },
      },
    });
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Подключить вход по почте" }).click();
  await expect(page.getByLabel("Новый пароль")).toBeVisible();
  const bounds = await page.locator(".account-email-link form").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});

test("email account changes password and keeps the current session", async ({
  page,
}) => {
  let changed = false;
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        user: null,
        account: {
          id: "email-owner",
          name: "Участник",
          createdAt: "2026-10-01",
          fullAccess: false,
          provider: "email",
          providers: ["email"],
        },
        local: false,
        email: true,
        yandex: false,
        vk: false,
      },
    }),
  );
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/account/sessions", (route) =>
    route.fulfill({
      json: {
        currentExpiresAt: null,
        otherCount: changed ? 0 : 1,
        items: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            isCurrent: true,
            createdAt: null,
            expiresAt: "2026-12-31T00:00:00.000Z",
          },
          ...(changed
            ? []
            : [
                {
                  id: "22222222-2222-4222-8222-222222222222",
                  isCurrent: false,
                  createdAt: null,
                  expiresAt: "2026-12-31T00:00:00.000Z",
                },
              ]),
        ],
      },
    }),
  );
  await page.route("**/api/auth/email/password/change", (route) => {
    const body = route.request().postDataJSON();
    if (body.currentPassword !== "correct horse battery staple")
      return route.fulfill({
        status: 400,
        json: { error: "Неверный текущий пароль." },
      });
    expect(body.newPassword).toBe("another correct horse password");
    changed = true;
    return route.fulfill({
      status: 200,
      json: { changed: true, revokedSessions: 1 },
    });
  });
  await page.goto("/account");
  await page.getByRole("button", { name: "Сменить пароль" }).click();
  const form = page.locator(".account-password-change form");
  await form.getByLabel("Текущий пароль").fill("incorrect old password");
  await form
    .getByLabel("Новый пароль", { exact: true })
    .fill("another correct horse password");
  await form
    .getByLabel("Повторите новый пароль")
    .fill("another correct horse password");
  await form.getByRole("button", { name: "Сохранить пароль" }).click();
  await expect(form.getByRole("alert")).toHaveText("Неверный текущий пароль.");
  await form.getByLabel("Текущий пароль").fill("correct horse battery staple");
  await form.getByRole("button", { name: "Сохранить пароль" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Другие сеансы завершены",
  );
  await expect(
    page.locator(".account-session-list").getByText("Этот сеанс"),
  ).toBeVisible();
  await expect(
    page.locator(".account-session-list").getByText("Другой сеанс"),
  ).toHaveCount(0);
  expect(changed).toBe(true);
  const bounds = await page.locator(".account-password-change").boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
});

test("OAuth-only account does not offer a password-change form", async ({
  page,
}) => {
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        user: null,
        account: {
          id: "oauth-only",
          name: "Участник",
          createdAt: "2026-10-01",
          fullAccess: false,
          provider: "yandex",
          providers: ["yandex"],
        },
        local: false,
        email: true,
        yandex: true,
        vk: false,
      },
    }),
  );
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives: [] } }),
  );
  await page.route("**/api/account/sessions", (route) =>
    route.fulfill({ json: { currentExpiresAt: null, otherCount: 0 } }),
  );
  await page.goto("/account");
  await expect(
    page.getByRole("button", { name: "Сменить пароль" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Подключить вход по почте" }),
  ).toBeVisible();
});
