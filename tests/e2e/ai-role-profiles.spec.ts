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
  await page.locator(".ai-default-settings > summary").click();
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
  await page
    .getByLabel("Запросов в день на пользователя", { exact: true })
    .fill("25");
  await page
    .getByRole("button", { name: /Родственник.*Общие настройки/ })
    .click();
  await expect(page.locator(".ai-inherited-profile")).toBeVisible();
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
    .getByRole("button", { name: /Исследователь.*Свои настройки/ })
    .click();
  await expect(
    page.getByLabel("Запросов в день на пользователя", { exact: true }),
  ).toHaveValue("25");
  await expect(
    page.getByLabel("Модель для этой роли", { exact: true }),
  ).toHaveValue("gpt://folder/research");
  await page
    .getByRole("button", { name: /Родственник.*Свои настройки/ })
    .click();
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
  await page.locator(".ai-default-settings > summary").click();
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
    : [768, 1024, 1440]) {
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

test("model check uses the unsaved role draft and locks edits without saving it", async ({
  page,
}) => {
  const models = [
    { id: "gpt://draft-folder/basic", label: "Basic", owner: "Yandex" },
    { id: "gpt://draft-folder/research", label: "Research", owner: "Yandex" },
  ];
  let saves = 0;
  let preview: Record<string, unknown> | null = null;
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/admin/ai", async (route) => {
    if (route.request().method() === "PUT") saves++;
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: {
        ...data,
        models,
        modelsError: "",
        configured: true,
        apiKeyConfigured: true,
        folderId: "draft-folder",
        folderIdOverride: "draft-folder",
        model: models[0].id,
        modelOverride: models[0].id,
        roleProfiles: {
          admin: null,
          researcher: null,
          relative: null,
          reader: null,
        },
        defaultRoleProfile: { ...data.defaultRoleProfile, model: models[0].id },
      },
    });
  });
  await page.route("**/api/admin/ai/test?role=researcher", async (route) => {
    preview = route.request().postDataJSON();
    await pending;
    await route.fulfill({
      json: {
        ok: true,
        model: models[1].id,
        answer: "OK",
        compactionAvailable: true,
      },
    });
  });
  await page.goto("/admin");
  await openAdminSection(page, "ai", "Yandex AI");
  await expect(
    page.getByRole("button", { name: "Сохранить", exact: true }),
  ).toBeDisabled();
  // A global pause must not become a permanent denial in a new role profile.
  await page.locator("#ai-research-enabled").uncheck();
  await page
    .getByRole("button", { name: /Исследователь.*Нет доступа/ })
    .click();
  await page
    .getByRole("checkbox", {
      name: "Использовать общие настройки",
      exact: true,
    })
    .uncheck();
  await expect(
    page.getByRole("checkbox", { name: "Доступ к ИИ", exact: true }),
  ).toBeChecked();
  await page.locator("#ai-research-enabled").check();
  await page
    .getByLabel("Модель для этой роли", { exact: true })
    .selectOption(models[1].id);
  await page
    .getByLabel("Запросов в день на пользователя", { exact: true })
    .fill("27");
  await page
    .getByRole("button", { name: "Проверить модель роли", exact: true })
    .click();
  await expect.poll(() => preview !== null).toBe(true);
  const sent = preview as unknown as { roleProfiles: AiRoleProfiles };
  expect(sent.roleProfiles.researcher?.model).toBe(models[1].id);
  expect(sent.roleProfiles.researcher?.dailyRequests).toBe(27);
  await expect(page.locator("#ai-profile-model")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Сохранить", exact: true }),
  ).toBeDisabled();
  finish();
  await expect(page.locator(".admin-notice")).toContainText(
    "Проверка текущих настроек успешна · Research",
  );
  await expect(page.locator("#ai-profile-model")).toBeEnabled();
  await expect(page.locator(".ai-draft-state")).toHaveText("Есть изменения");
  expect(saves).toBe(0);
  await page
    .getByLabel("Запросов в день на пользователя", { exact: true })
    .fill("28");
  await expect(page.locator(".admin-notice")).toHaveCount(0);
});

test("AI draft is protected across section, archive and profile navigation", async ({
  page,
}, info) => {
  const otherArchive = "22222222-2222-4222-8222-222222222222";
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({
      json: {
        archives: [
          {
            id: otherArchive,
            title: "Другое древо",
            approved: true,
            current: false,
          },
        ],
      },
    }),
  );
  await page.goto("/admin");
  await openAdminSection(page, "ai", "Yandex AI");
  await expect(page.locator(".ai-connection-editor")).toBeVisible();
  if (
    (await page.locator(".ai-connection-editor").getAttribute("open")) === null
  )
    await page.locator(".ai-connection-editor > summary").click();
  await page.getByLabel("Folder ID", { exact: true }).fill("unsaved-folder");
  await expect(page.locator(".ai-draft-state")).toHaveText("Есть изменения");
  const dialogs: string[] = [];
  page.on("dialog", async (dialog) => {
    dialogs.push(dialog.message());
    await dialog.dismiss();
  });
  await openAdminSection(page, "storage", "Хранилище");
  await expect(page.getByLabel("Folder ID", { exact: true })).toHaveValue(
    "unsaved-folder",
  );
  await page
    .getByLabel("Древо для Yandex AI", { exact: true })
    .selectOption(otherArchive);
  await expect(
    page.getByLabel("Древо для Yandex AI", { exact: true }),
  ).toHaveValue("");
  await expect(page.getByLabel("Folder ID", { exact: true })).toHaveValue(
    "unsaved-folder",
  );
  // Desktop has a sidebar back link; mobile uses the navigation panel.
  if (info.project.name === "desktop") {
    await page
      .getByRole("link", { name: "Вернуться в профиль", exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin$/);
    expect(dialogs).toHaveLength(3);
  } else expect(dialogs).toHaveLength(2);
  expect(
    dialogs.every((text) => text.includes("несохранённые изменения")),
  ).toBe(true);
  page.removeAllListeners("dialog");
  page.once("dialog", (dialog) => dialog.accept());
  await openAdminSection(page, "storage", "Хранилище");
  await expect(
    page.getByRole("heading", { name: "Лимиты хранилища", exact: true }),
  ).toBeVisible();
  await openAdminSection(page, "ai", "Yandex AI");
  await expect(page.locator(".ai-draft-state")).toHaveText(
    "Все изменения сохранены",
  );
  await expect(page.locator("#ai-folder-id")).not.toHaveValue("unsaved-folder");
});
