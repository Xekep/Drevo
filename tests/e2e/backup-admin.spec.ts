import { test, expect } from "@playwright/test";
import type { BackupStatus } from "../../src/shared/backup-management";

test("экспорт отделён от резервных копий; настройки и восстановление помещаются на экране", async ({
  page,
}, testInfo) => {
  let applied = false;
  const state: BackupStatus = {
    settings: {
      enabled: true,
      intervalHours: 24,
      keepCount: 30,
      storage: "local",
      remoteHost: "",
      remoteDirectory: "",
    },
    nextRunAt: "2026-09-26T10:00:00Z",
    localDirectory: "/var/www/drevo.kiiko.ru/shared/backups",
    sshConfig: "/var/www/drevo.kiiko.ru/shared/backup-ssh/config",
    total: 1,
    job: null,
    records: [
      {
        id: "d6688201-4f30-47a2-a99b-39d0bb5ec2cf",
        name: "full-20260925T100000Z.tar.gz",
        createdAt: "2026-09-25T10:00:00Z",
        size: 120000000,
        sha256: "a".repeat(64),
        storage: "local",
        remoteHost: "",
        remoteDirectory: "",
      },
    ],
  };
  await page.route("**/api/backups**", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.endsWith("/settings")) {
      state.settings = request.postDataJSON();
      return route.fulfill({ json: state.settings });
    }
    if (url.pathname.endsWith("/preview")) {
      state.job = {
        id: "preview-job",
        kind: "preview",
        state: "succeeded",
        startedAt: new Date().toISOString(),
        preview: {
          token: "preview",
          title: "Копия семейного архива",
          people: 84,
          photos: 42,
          documents: 2,
          files: 42,
          missing: 0,
          currentPeople: 90,
          currentPhotos: 45,
        },
      };
      return route.fulfill({ status: 202, json: state.job });
    }
    return route.fulfill({ json: state });
  });
  await page.route("**/api/restore/apply", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      token: "preview",
      confirm: true,
    });
    applied = true;
    await route.fulfill({ json: { backupName: "before-import.sqlite" } });
  });
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Экспорт и импорт", exact: true })
    .click();
  await expect(
    page.getByRole("link", { name: "Экспорт JSON без фото" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Создать копию", exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Резервные копии", exact: true })
    .click();
  await page.getByLabel("Период, часов").fill("12");
  await page.getByLabel("Количество копий").fill("7");
  await expect(
    page.getByRole("button", { name: "Создать копию", exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect(
    page.getByText("Настройки сохранены.", { exact: true }),
  ).toBeVisible();
  expect(state.settings.intervalHours).toBe(12);
  expect(state.settings.keepCount).toBe(7);
  await page.getByLabel("Хранилище", { exact: true }).selectOption("remote");
  await page.getByLabel("SSH-подключение", { exact: true }).fill("vault");
  await page
    .getByLabel("Каталог на сервере", { exact: true })
    .fill("/srv/backups/drevo");
  await expect(
    page.getByRole("button", { name: "Проверить подключение" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await page.getByRole("button", { name: /Восстановить копию от/ }).click();
  await expect(
    page.getByText("Копия семейного архива", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Восстановить архив", exact: true }),
  ).toBeDisabled();
  expect(applied).toBe(false);
  const sizes =
    testInfo.project.name === "mobile" ? [320, 390, 768] : [1024, 1440];
  for (const width of sizes) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page
      .locator(".backup-admin")
      .evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(overflow, "backup panel width " + width).toBeLessThanOrEqual(1);
    await page
      .getByRole("heading", { name: "Автоматические копии" })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath("backup-admin-" + width + ".png"),
      fullPage: true,
    });
  }
  await page.screenshot({
    path: testInfo.outputPath("backup-admin.png"),
    fullPage: true,
  });
  await page
    .getByLabel("Заменить текущие данные содержимым этого бэкапа")
    .check();
  await page
    .getByRole("button", { name: "Восстановить архив", exact: true })
    .click();
  await expect.poll(() => applied).toBe(true);
});
