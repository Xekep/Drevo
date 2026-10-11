import { expect, test, type Page } from "@playwright/test";
import type { AiRoleProfiles } from "../../src/shared/ai-role-profiles";
import { openAdminSection } from "./admin-navigation";

const models = [
  { id: "gpt://folder/basic", label: "Basic", owner: "Yandex" },
  { id: "gpt://folder/research", label: "Research", owner: "Yandex" },
];

async function mockSettings(page: Page) {
  let profiles: AiRoleProfiles = {
    admin: null,
    researcher: null,
    relative: null,
    reader: null,
  };
  let saves = 0;
  let baseline: Record<string, unknown> | null = null;
  const paths: string[] = [];
  await page.route(/\/api\/admin\/ai(?:\?.*)?$/, async (route) => {
    paths.push(new URL(route.request().url()).pathname);
    if (!baseline) {
      const response = await route.fetch();
      const data = await response.json();
      baseline = {
        ...data,
        configured: true,
        apiKeyConfigured: true,
        folderId: "folder",
        folderIdOverride: "folder",
        model: models[0].id,
        modelOverride: models[0].id,
        defaultRoleProfile: { ...data.defaultRoleProfile, model: models[0].id },
      };
    }
    if (route.request().method() === "PUT") {
      saves++;
      const draft = route.request().postDataJSON();
      profiles = draft.roleProfiles;
      baseline = {
        ...baseline,
        enabled: draft.enabled,
        roleProfiles: profiles,
      };
    }
    return route.fulfill({
      json: {
        ...baseline,
        roleProfiles: profiles,
        models: [],
        modelsError: "",
      },
    });
  });
  await page.route("**/api/admin/ai/models", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: { models } });
  });
  return { profiles: () => profiles, saves: () => saves, paths };
}

test("platform AI settings expose independent role models and limits without tree or common-model controls", async ({
  page,
}, info) => {
  const state = await mockSettings(page);
  await page.goto("/admin");
  await openAdminSection(page, "ai", "Yandex AI");
  await expect(page.getByLabel("Древо для Yandex AI")).toHaveCount(0);
  await expect(page.locator("#ai-model")).toHaveCount(0);
  await expect(
    page.locator(
      ".ai-default-settings, .ai-budget-settings, #ai-profile-inherit",
    ),
  ).toHaveCount(0);
  const roleModel = page.getByLabel("Модель для этой роли", { exact: true });
  await expect(roleModel.getByRole("option")).toContainText([
    "Basic",
    "Research",
  ]);
  await expect(
    page.getByRole("button", { name: "Сохранить", exact: true }),
  ).toBeDisabled();
  await page
    .getByRole("button", { name: /Исследователь.*Доступ разрешён/ })
    .click();
  await roleModel.selectOption(models[1].id);
  await page
    .getByLabel("Запросов в день на пользователя", { exact: true })
    .fill("25");
  await page.locator(".ai-role-features > summary").click();
  await page
    .getByLabel("Поиск по доверенным ресурсам", { exact: true })
    .check();
  await page.getByLabel("Поиск по всему интернету", { exact: true }).uncheck();
  await page.getByLabel("Создание PDF-отчётов", { exact: true }).uncheck();
  await page.locator("#ai-profile-codeInterpreterEnabled").check();
  await page
    .getByRole("button", { name: /Родственник.*Доступ разрешён/ })
    .click();
  await expect(roleModel).toHaveValue(models[0].id);
  await page
    .getByRole("checkbox", { name: "Доступ к ИИ", exact: true })
    .uncheck();
  await page
    .getByRole("button", { name: /Исследователь.*Доступ разрешён/ })
    .click();
  await expect(roleModel).toHaveValue(models[1].id);
  await expect(
    page.getByLabel("Запросов в день на пользователя", { exact: true }),
  ).toHaveValue("25");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(
    page.getByText("Настройки AI Studio сохранены", { exact: true }),
  ).toBeVisible();
  expect(state.profiles().researcher?.model).toBe(models[1].id);
  expect(state.profiles().researcher?.dailyRequests).toBe(25);
  expect(state.profiles().researcher?.globalSearchEnabled).toBe(false);
  expect(state.profiles().researcher?.pdfEnabled).toBe(false);
  expect(state.profiles().researcher?.codeInterpreterEnabled).toBe(true);
  expect(state.profiles().relative?.enabled).toBe(false);
  expect(Object.values(state.profiles()).every(Boolean)).toBe(true);
  expect(state.paths.every((path) => path.startsWith("/api/admin/ai"))).toBe(
    true,
  );
  await page.reload();
  await openAdminSection(page, "ai", "Yandex AI");
  await page
    .getByRole("button", { name: /Исследователь.*Доступ разрешён/ })
    .click();
  await expect(roleModel).toHaveValue(models[1].id);
  await expect(
    page.getByLabel("Запросов в день на пользователя", { exact: true }),
  ).toHaveValue("25");
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
  await page.getByRole("button", { name: /Читатель/ }).click();
  await page.locator(".ai-role-features > summary").click();
  await expect(
    page.getByLabel("Предложения изменений в архиве", { exact: true }),
  ).toBeDisabled();
});

test("role model check uses its unsaved draft and locks edits without saving", async ({
  page,
}) => {
  const state = await mockSettings(page);
  let preview: { roleProfiles: AiRoleProfiles } | null = null;
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
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
    page
      .getByLabel("Модель для этой роли", { exact: true })
      .getByRole("option"),
  ).toContainText(["Research"]);
  await page.locator("#ai-research-enabled").uncheck();
  await page
    .getByRole("button", { name: /Исследователь.*Нет доступа/ })
    .click();
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
  expect(state.saves()).toBe(0);
  await page
    .getByLabel("Запросов в день на пользователя", { exact: true })
    .fill("28");
  await expect(page.locator(".admin-notice")).toHaveCount(0);
});

test("AI draft remains protected across section and profile navigation", async ({
  page,
}, info) => {
  await mockSettings(page);
  await page.goto("/admin");
  await openAdminSection(page, "ai", "Yandex AI");
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
  if (info.project.name === "desktop") {
    await page
      .getByRole("link", { name: "Вернуться в профиль", exact: true })
      .click();
    await expect(page).toHaveURL(/\/admin$/);
    expect(dialogs).toHaveLength(2);
  } else expect(dialogs).toHaveLength(1);
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

test("catalog failure preserves role selection and refresh uses unsaved credentials without saving", async ({
  page,
}) => {
  const state = await mockSettings(page);
  let finish: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const submitted: Array<{
    folderId: string;
    apiKey?: string;
    forceRefresh?: boolean;
  }> = [];
  await page.route("**/api/admin/ai/models", async (route) => {
    submitted.push(route.request().postDataJSON());
    if (submitted.length === 1) {
      await pending;
      return route.fulfill({
        status: 502,
        json: { error: "Каталог моделей временно недоступен" },
      });
    }
    if (submitted.length === 2)
      return route.fulfill({
        status: 502,
        json: { error: "Нет ответа каталога" },
      });
    return route.fulfill({ json: { models } });
  });
  await page.goto("/admin");
  await openAdminSection(page, "ai", "Yandex AI");
  const roleModel = page.getByLabel("Модель для этой роли", { exact: true });
  await expect(
    page.getByRole("button", { name: "Загружаем модели…", exact: true }),
  ).toBeVisible();
  await expect(roleModel).toBeEnabled();
  await page
    .getByLabel("Запросов в день на пользователя", { exact: true })
    .fill("42");
  await expect(page.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
  finish();
  await expect(page.getByRole("alert")).toHaveText(
    "Каталог моделей временно недоступен",
  );
  await expect(roleModel).toHaveValue(models[0].id);
  await page.locator(".ai-connection-editor > summary").click();
  await page.getByLabel("Folder ID", { exact: true }).fill("new-folder");
  await page.getByLabel("API-ключ", { exact: true }).fill("new-key");
  await page
    .getByRole("button", { name: "Обновить список моделей", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText("Нет ответа каталога");
  expect(submitted[1]).toEqual({
    folderId: "new-folder",
    apiKey: "new-key",
    forceRefresh: true,
  });
  await expect(roleModel).toHaveValue(models[0].id);
  await page
    .getByRole("button", { name: "Обновить список моделей", exact: true })
    .click();
  await expect(roleModel.getByRole("option")).toContainText([
    "Basic",
    "Research",
  ]);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(
    page.getByLabel("Запросов в день на пользователя", { exact: true }),
  ).toHaveValue("42");
  expect(state.saves()).toBe(0);
  expect(submitted[0]).toEqual({ folderId: "folder" });
});
