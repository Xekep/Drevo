import { test, expect } from "@playwright/test";
import type { BackupStatus } from "../../src/shared/backup-management.ts";

test("owner renames the tree from management without changing people or photos", async ({ page }) => {
  const original = await page.request.get("/api/family").then(response => response.json());
  try {
    await page.goto("/manage?section=settings");
    await page.getByLabel("Название древа", { exact: true }).fill("  Архив нашей семьи  ");
    await page.getByRole("button", { name: "Сохранить настройки", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("Настройки сохранены");
    const saved = await page.request.get("/api/family").then(response => response.json());
    expect(saved.family.title).toBe("Архив нашей семьи");
    expect(saved.family.people).toEqual(original.family.people);
    expect(saved.family.photos).toEqual(original.family.photos);
    await page.reload();
    await expect(page.getByLabel("Название древа", { exact: true })).toHaveValue("Архив нашей семьи");
    await page.goto("/manage?section=shares");
    await expect(page.getByRole("heading", { name: "Общий доступ", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Публичный просмотр" })).toHaveCount(0);
  } finally {
    const latest = await page.request.get("/api/family").then(response => response.json());
    await page.request.put("/api/family", {
      headers: { "If-Match": String(latest.revision) }, data: original.family,
    });
  }
});

test("an empty tree completes camera preparation and exposes its add-person action", async ({ page }) => {
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), body = await response.json();
    body.family = { ...body.family, people: [], photos: [], links: [], unions: [], demo: false };
    body.totals = { ...body.totals, people: 0, photos: 0 };
    await route.fulfill({ response, json: body });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-camera-ready", "true");
  await expect(page.locator(".tree-canvas")).toHaveAttribute("aria-busy", "false");
  await expect(page.locator(".tree-preparation-status")).toHaveCount(0);
});

test("retired query links and long invitations are unavailable", async ({ page }) => {
  for (const path of ["/photos?personId=e2e-child", "/photos?photo=e2e-photo", "/tree?person=e2e-child",
    "/a/example-tree/admin", `/join/example-tree/${"a".repeat(43)}`, "/discover?q=Иван"]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: "Здесь пока нет ветви" })).toBeVisible();
  }
});

test("tree backup controls save only retention and require confirmation before deleting", async ({ page }) => {
  const id = "d6688201-4f30-47a2-a99b-39d0bb5ec2cf";
  const state: BackupStatus = { settings: { enabled: false, intervalHours: 24, keepCount: 5,
    storage: "local", remoteHost: "", remoteDirectory: "" }, nextRunAt: null,
    localDirectory: "/tree-backups", sshConfig: "", total: 1, job: null,
    records: [{ id, name: `tree-20261113T100000Z-${id}.tar.gz`, createdAt: "2026-11-13T10:00:00Z",
      size: 1024, sha256: "a".repeat(64), storage: "local", remoteHost: "", remoteDirectory: "" }] };
  let deletions = 0;
  await page.route(url => url.pathname.startsWith("/api/backups"), async route => {
    const request = route.request();
    if (request.method() === "PUT") {
      expect(request.postDataJSON()).toEqual({ keepCount: 2 });
      state.settings.keepCount = 2;
      return route.fulfill({ json: state.settings });
    }
    if (request.method() === "DELETE") {
      expect(new URL(request.url()).pathname).toBe("/api/backups/" + id);
      deletions++;
      state.records = []; state.total = 0;
      state.job = { id, kind: "delete", state: "succeeded", startedAt: "2026-11-13T10:00:00Z" };
      return route.fulfill({ status: 202, json: state.job });
    }
    return route.fulfill({ json: state });
  });
  await page.goto("/manage?section=backups");
  await page.getByLabel("Количество копий", { exact: true }).fill("2");
  await page.getByRole("button", { name: "Сохранить лимит" }).click();
  await expect(page.getByText("Настройки сохранены.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Удалить копию от/ }).click();
  expect(deletions).toBe(0);
  await page.getByRole("button", { name: /^Подтвердить удаление от/ }).click();
  await expect(page.getByText("Копия удалена.", { exact: true })).toBeVisible();
  await expect(page.locator(".backup-list li")).toHaveCount(0);
  expect(deletions).toBe(1);
});
