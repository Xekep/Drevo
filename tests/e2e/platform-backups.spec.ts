import { expect, test } from "@playwright/test";
import type { BackupStatus } from "../../src/shared/backup-management";

test("platform backups have a global endpoint and no archive picker or live restore", async ({ page }, info) => {
  const paths: string[] = [];
  let familyReads = 0;
  const state: BackupStatus = { settings: { enabled: false, intervalHours: 24, keepCount: 7,
    storage: "local", remoteHost: "", remoteDirectory: "" }, nextRunAt: null,
    localDirectory: "/test/platform-backups", sshConfig: "/test/ssh-config", records: [], total: 0, job: null };
  await page.route("**/api/family**", (route) => {
    familyReads++; return route.fulfill({ status: 403, json: { error: "No archive in platform settings" } });
  });
  await page.route("**/api/session", (route) => route.fulfill({ json: {
    local: false, canEdit: false, yandex: false, vk: false, user: null,
    account: { id: "operator", name: "Оператор", globalRole: "admin", fullAccess: true },
  } }));
  await page.route("**/api/account/archives", (route) => route.fulfill({ json: { archives: [] } }));
  await page.route("**/api/platform/roles**", (route) => route.fulfill({ json: { accounts: [], next: null } }));
  await page.route("**/api/platform/backups**", (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(route.request().method() + " " + path);
    if (route.request().method() === "PUT") {
      state.settings = route.request().postDataJSON();
      return route.fulfill({ json: state.settings });
    }
    return route.fulfill({ json: state });
  });
  await page.goto("/admin");
  await page.getByRole("button", { name: "Резервные копии", exact: true }).click();
  await expect(page.getByLabel("Архив для резервных копий")).toHaveCount(0);
  await expect(page.getByLabel("Количество копий")).toHaveValue("7");
  await page.getByLabel("Количество копий").fill("10");
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect.poll(() => paths).toContain("PUT /api/platform/backups/settings");
  await expect(page.getByText(/Полное восстановление выполняет/)).toBeVisible();
  await expect(page.getByRole("button", { name: /Восстановить копию/ })).toHaveCount(0);
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("global-backups-" + width + ".png") });
  }
  expect(familyReads).toBe(0);
});
