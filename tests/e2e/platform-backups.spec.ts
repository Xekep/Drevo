import { expect, test, type Page } from "@playwright/test";
import type { BackupStatus } from "../../src/shared/backup-management";
import type { Family } from "../../src/domain/types.ts";

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
  await page.route("**/api/platform/accounts**", (route) => route.fulfill({ json: { accounts: [], next: null } }));
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

async function managedTree(page: Page, globalRole: "admin" | "researcher" | null, preview = false) {
  const paths: string[] = [];
  const user = { id: "tree-owner", name: "Владелец", role: "relative", treeRole: "relative",
    archiveOwner: true, approved: true, globalRole, fullAccess: true, createdAt: "2026-10-06" };
  const family: Family = { title: "Отдельное древо", description: "", demo: false, people: [{ id: "synthetic-person",
    name: "Иван", surname: "Тестов", patronymic: "", sex: "m", birth: "1970", birthPlace: "",
    parents: [], spouses: [], sources: [], generation: 1, column: 0, photo: "" }],
    photos: [], links: [], unions: [] };
  const status: BackupStatus = { settings: { enabled: false, keepCount: 5, intervalHours: 24,
    storage: "local", remoteHost: "", remoteDirectory: "" }, nextRunAt: null,
    localDirectory: "/test/tree-backups", sshConfig: "", total: 1, job: null,
    records: [{ id: "11111111-1111-4111-8111-111111111111", name: "tree-copy.tar.gz",
      createdAt: "2026-10-06T00:00:00Z", size: 100, sha256: "a".repeat(64), storage: "local",
      remoteHost: "", remoteDirectory: "" }] };
  await page.route("**/api/session", (route) => route.fulfill({ json: { user,
    account: preview ? null : { id: user.id, name: user.name, globalRole, fullAccess: true },
    participantPreview: preview ? { id: user.id, name: user.name } : undefined,
    local: false, canEdit: !preview, yandex: false, vk: false } }));
  await page.route("**/api/family**", (route) => route.fulfill({ json: {
    family, user, canEdit: !preview, local: false, revision: 1, treePreferences: {},
  } }));
  await page.route("**/api/settings", (route) => route.fulfill({ json: {
    publicTree: false, publicAlbums: false, reverseTimeline: false,
  } }));
  await page.route("**/api/users**", (route) => route.fulfill({ json: { users: [user], total: 1, next: null } }));
  await page.route("**/api/backups**", (route) => {
    const path = new URL(route.request().url()).pathname;
    paths.push(route.request().method() + " " + path);
    if (path.endsWith("/create")) status.job = {
      id: "created", kind: "create", state: "succeeded", startedAt: "2026-10-06T00:00:00Z",
    };
    if (path.endsWith("/preview")) status.job = { id: "preview", kind: "preview", state: "succeeded",
      startedAt: "2026-10-06T00:00:00Z", preview: { token: "scoped-preview", title: "Копия древа",
        people: 0, photos: 0, files: 0, missing: 0, currentPeople: 0, currentPhotos: 0,
        currentCommentsLost: 0, backupCommentsSkipped: 0 } };
    return route.fulfill({ json: path.endsWith("/create") || path.endsWith("/preview") ? status.job : status });
  });
  await page.route("**/api/restore/apply", (route) => {
    paths.push("POST " + new URL(route.request().url()).pathname);
    expect(route.request().postDataJSON()).toMatchObject({ token: "scoped-preview", confirm: true });
    return route.fulfill({ json: { backupName: "before-restore.sqlite" } });
  });
  await page.goto(preview ? "/a/tree-a/preview/tree-owner/tree" : "/a/tree-a/manage");
  return paths;
}

for (const example of [
  { name: "researcher owner", role: "researcher" as const, preview: false, allowed: true },
  { name: "admin owner", role: "admin" as const, preview: false, allowed: true },
  { name: "ordinary owner", role: null, preview: false, allowed: false },
  { name: "participant preview", role: "researcher" as const, preview: true, allowed: false },
]) test(`manual tree backups: ${example.name}`, async ({ page }) => {
  const paths = await managedTree(page, example.role, example.preview);
  if (example.preview) {
    await expect(page.getByRole("link", { name: "Выйти из просмотра", exact: true }))
      .toHaveAttribute("href", "/a/tree-a/manage");
    await expect(page.locator(".admin-mark")).toHaveCount(0);
  } else {
    await expect(page.locator(".admin-mark b")).toHaveText("Управление древом");
  }
  const tab = page.getByRole("button", { name: "Резервные копии", exact: true });
  if (!example.allowed) {
    await expect(tab).toHaveCount(0);
    expect(paths).toEqual([]);
    return;
  }
  await tab.click();
  await expect(page.getByRole("button", { name: "Создать копию", exact: true })).toBeVisible();
  await expect(page.getByLabel("Количество копий")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Автоматические копии" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Скачать копию от/ })).toHaveAttribute("href",
    "/a/tree-a/api/backups/11111111-1111-4111-8111-111111111111/download");
  if (example.role === "researcher") {
    await page.getByRole("button", { name: "Создать копию", exact: true }).click();
    await expect.poll(() => paths).toContain("POST /a/tree-a/api/backups/create");
    await page.getByRole("button", { name: /Восстановить копию от/ }).click();
    await expect(page.getByRole("heading", { name: "Копия древа" })).toBeVisible();
    await page.getByLabel("Заменить текущие данные содержимым этого бэкапа").check();
    await page.getByRole("button", { name: "Восстановить архив", exact: true }).click();
    await expect.poll(() => paths).toContain("POST /a/tree-a/api/restore/apply");
  }
  expect(paths.every((path) => path.includes("/a/tree-a/api/"))).toBe(true);
});
