import { expect, test, type Page } from "@playwright/test";
import type { BackupStatus } from "../../src/shared/backup-management";

const owner = {
  id: "operator",
  name: "Администратор",
  role: "relative",
  treeRole: "relative",
  approved: true,
  archiveOwner: true,
  platformAdmin: true,
  globalRole: "admin",
  aiAvailable: true,
};
const archives = [
  {
    id: "primary-tree",
    title: "Основной архив",
    current: true,
    approved: true,
    owned: true,
  },
  {
    id: "owned-alpha",
    title: "Архив Альфа",
    current: false,
    approved: true,
    owned: true,
  },
  {
    id: "owned-beta",
    title: "Архив Бета",
    current: false,
    approved: true,
    owned: true,
  },
  {
    id: "invited-tree",
    title: "Чужое дерево",
    current: false,
    approved: true,
    owned: false,
  },
  {
    id: "waiting-tree",
    title: "Ожидает допуска",
    current: false,
    approved: false,
    owned: true,
  },
];
async function platform(
  page: Page,
  session?: (path: string) => Partial<typeof owner>,
) {
  let familyReads = 0;
  await page.route("**/api/family**", (route) => {
    familyReads++;
    return route.fulfill({
      status: 403,
      json: { error: "No family load in platform" },
    });
  });
  await page.route("**/api/session", (route) =>
    route.fulfill({
      json: {
        local: false,
        canEdit: true,
        yandex: false,
        vk: false,
        account: {
          id: "operator",
          name: "Администратор",
          fullAccess: true,
          globalRole: "admin",
        },
        user: {
          ...owner,
          ...session?.(new URL(route.request().url()).pathname),
        },
      },
    }),
  );
  await page.route("**/api/account/archives", (route) =>
    route.fulfill({ json: { archives } }),
  );
  await page.route("**/api/platform/roles", (route) =>
    route.fulfill({ json: { accounts: [], next: null } }),
  );
  await page.route("**/api/platform/tiers**", (route) =>
    route.fulfill({
      json: {
        accounts: [],
        next: null,
        totals: { basic: 0, full: 0 },
      },
    }),
  );
  await page.goto("/admin");
  return () => familyReads;
}
const backup: BackupStatus = {
  settings: {
    enabled: false,
    intervalHours: 24,
    keepCount: 7,
    storage: "local",
    remoteHost: "",
    remoteDirectory: "",
  },
  nextRunAt: null,
  localDirectory: "/test/backups",
  sshConfig: "/test/ssh-config",
  total: 1,
  job: null,
  records: [
    {
      id: "saved-backup",
      name: "saved.tar.gz",
      createdAt: "2026-10-05T00:00:00Z",
      size: 100,
      sha256: "a".repeat(64),
      storage: "local",
      remoteHost: "",
      remoteDirectory: "",
    },
  ],
};

test("backup settings, download and restoration target the selected archive", async ({
  page,
}, info) => {
  const paths: string[] = [];
  const state = structuredClone(backup);
  await page.route("**/api/backups**", (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(`${route.request().method()} ${path}`);
    if (path.endsWith("/settings")) {
      state.settings = route.request().postDataJSON();
      return route.fulfill({ json: state.settings });
    }
    if (path.endsWith("/preview")) {
      state.job = {
        id: "preview-job",
        kind: "preview",
        state: "succeeded",
        startedAt: "2026-10-05",
        preview: {
          token: "selected-preview",
          title: "Копия Альфа",
          people: 1,
          photos: 0,
          documents: 0,
          files: 0,
          missing: 0,
          currentPeople: 0,
          currentPhotos: 0,
          currentCommentsLost: 0,
          backupCommentsSkipped: 0,
          canRestoreComments: false,
          commentsRestoreReason: "",
        },
      };
      return route.fulfill({ status: 202, json: state.job });
    }
    return route.fulfill({ json: state });
  });
  await page.route("**/api/restore/apply", (route) => {
    paths.push(`POST ${new URL(route.request().url()).pathname}`);
    expect(route.request().postDataJSON()).toEqual({
      token: "selected-preview",
      confirm: true,
      restoreComments: false,
    });
    return route.fulfill({ json: { backupName: "test-before.sqlite" } });
  });
  const familyReads = await platform(page);
  await page
    .getByRole("button", { name: "Резервные копии", exact: true })
    .click();
  await page
    .getByLabel("Архив для резервных копий")
    .selectOption("owned-alpha");
  await expect(page.getByLabel("Количество копий")).toHaveValue("7");
  await page.getByLabel("Количество копий").fill("10");
  await page.getByRole("button", { name: "Сохранить настройки" }).click();
  await expect
    .poll(() => paths)
    .toContain("PUT /a/owned-alpha/api/backups/settings");
  await expect(
    page.getByRole("link", { name: /Скачать копию от/ }),
  ).toHaveAttribute("href", "/a/owned-alpha/api/backups/saved-backup/download");
  await page.getByRole("button", { name: /Восстановить копию от/ }).click();
  await expect(
    page.getByRole("heading", { name: "Копия Альфа" }),
  ).toBeVisible();
  await page
    .getByLabel("Заменить текущие данные содержимым этого бэкапа")
    .check();
  await page
    .getByRole("button", { name: "Восстановить архив", exact: true })
    .click();
  await expect
    .poll(() => paths)
    .toContain("POST /a/owned-alpha/api/restore/apply");
  expect(familyReads()).toBe(0);
  for (const width of info.project.name === "mobile"
    ? [320, 390]
    : [1024, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByLabel("Архив для резервных копий").scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath(`platform-backup-${width}.png`),
      fullPage: true,
    });
  }
});
