import { expect, test } from "@playwright/test";
import type { AiRoleProfiles } from "../../src/shared/ai-role-profiles";
import { openAdminSection } from "./admin-navigation";

test("admin configures independent AI profiles and can restore inheritance", async ({
  page,
}, info) => {
  let profiles: AiRoleProfiles = {
    admin: null,
    researcher: null,
    relative: null,
    reader: null,
  };
  await page.route("**/api/admin/ai", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    if (route.request().method() === "PUT")
      profiles = route.request().postDataJSON().roleProfiles;
    await route.fulfill({
      response,
      json: {
        ...data,
        roleProfiles: profiles,
        models: [
          { id: "gpt://folder/basic", label: "Basic", owner: "Yandex" },
          { id: "gpt://folder/research", label: "Research", owner: "Yandex" },
        ],
      },
    });
  });
  await page.goto("/admin");
  await openAdminSection(page, "ai", "Yandex AI");
  await page.locator("#ai-code-interpreter-enabled").check();
  await expect(
    page.getByRole("checkbox", {
      name: "Использовать общие настройки",
      exact: true,
    }),
  ).toBeChecked();
  await page
    .getByRole("button", { name: /Исследователь.*Общие настройки/ })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Использовать общие настройки",
      exact: true,
    })
    .uncheck();
  await page
    .getByLabel("Модель для этой роли", { exact: true })
    .selectOption("gpt://folder/research");
  await page
    .getByLabel("Поиск по доверенным ресурсам", { exact: true })
    .check();
  await page.getByLabel("Поиск по всему интернету", { exact: true }).uncheck();
  await page.getByLabel("Создание PDF-отчётов", { exact: true }).uncheck();
  await page.locator("#ai-profile-codeInterpreterEnabled").uncheck();
  await page.getByText("Модель фото, лимиты и контекст").click();
  await page
    .getByLabel("Запросов в день на пользователя", { exact: true })
    .fill("25");
  await page
    .getByRole("button", { name: /Родственник.*Общие настройки/ })
    .click();
  await expect(
    page.getByRole("checkbox", {
      name: "Использовать общие настройки",
      exact: true,
    }),
  ).toBeChecked();
  await page
    .getByRole("checkbox", {
      name: "Использовать общие настройки",
      exact: true,
    })
    .uncheck();
  await page
    .getByRole("checkbox", { name: "Доступ к ИИ", exact: true })
    .uncheck();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    page.getByText("Настройки AI Studio сохранены", { exact: true }),
  ).toBeVisible();
  expect(profiles.researcher?.model).toBe("gpt://folder/research");
  expect(profiles.researcher?.dailyRequests).toBe(25);
  expect(profiles.researcher?.globalSearchEnabled).toBe(false);
  expect(profiles.researcher?.pdfEnabled).toBe(false);
  expect(profiles.researcher?.codeInterpreterEnabled).toBe(false);
  expect(profiles.relative?.enabled).toBe(false);
  await page.reload();
  await openAdminSection(page, "ai", "Yandex AI");
  await expect(page.locator("#ai-code-interpreter-enabled")).toBeChecked();
  await page
    .getByRole("button", { name: /Исследователь.*Свои настройки/ })
    .click();
  await expect(
    page.getByLabel("Модель для этой роли", { exact: true }),
  ).toHaveValue("gpt://folder/research");
  await expect(
    page.getByLabel("Поиск по всему интернету", { exact: true }),
  ).not.toBeChecked();
  for (const width of info.project.name === "mobile"
    ? [320, 390]
    : [1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - innerWidth,
      ),
    ).toBeLessThanOrEqual(1);
  }
  await page
    .locator(".ai-role-profiles")
    .screenshot({ path: info.outputPath("ai-role-profiles.png") });
  await page
    .getByRole("checkbox", {
      name: "Использовать общие настройки",
      exact: true,
    })
    .check();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    page.getByText("Настройки AI Studio сохранены", { exact: true }),
  ).toBeVisible();
  expect(profiles.researcher).toBeNull();
  expect(profiles.relative?.enabled).toBe(false);
});
