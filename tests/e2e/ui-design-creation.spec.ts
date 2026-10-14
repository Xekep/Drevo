import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import { fullName } from "../../src/domain/dates.ts";
import type { ArchiveUser, Family } from "../../src/domain";

async function isolatedCreation(page: Page, reader = false) {
  const overviewResponse = await page.request.get("/api/family?projection=overview");
  const overview = await overviewResponse.json();
  const fullResponse = await page.request.get("/api/family");
  const complete = await fullResponse.json();
  let family = structuredClone(complete.family) as Family;
  let revision = complete.revision as number;
  const baseline = structuredClone(family);
  const writes: Change[][] = [];
  const user: ArchiveUser = reader ? {
    id: "creation-reader", name: "Читатель", role: "reader", treeRole: "reader",
    archiveOwner: false, approved: true, createdAt: "2026-10-14", treeAccess: "all",
  } : complete.user;
  if (reader) {
    await page.route("**/api/session", (route) => route.fulfill({ json: {
      user, local: false, account: { id: user.id, name: user.name, createdAt: user.createdAt },
    } }));
  }
  // Every projection sees this private in-memory family; saves never reach the shared fixture.
  await page.route(/\/api\/family(?:\?|\/changes|$)/, (route) => {
    if (route.request().method() === "POST" && new URL(route.request().url()).pathname.endsWith("/changes")) {
      expect(reader).toBe(false);
      const changes = route.request().postDataJSON().changes as Change[];
      const applied = applyArchiveChanges(family, changes);
      expect(applied.conflicts).toEqual([]);
      writes.push(changes);
      family = applied.family;
      revision++;
      return route.fulfill({ json: { family, revision, appliedChanges: changes } });
    }
    return route.fulfill({ json: {
      ...overview, ...complete, family, revision, partial: false, pageToken: undefined,
      user, canEdit: !reader, local: !reader, readTree: true, readPhotos: true,
    } });
  });
  return { baseline, writes, saved: () => family };
}

for (const route of ["tree", "people"] as const) {
  test(`телефон создаёт независимого человека из ${route} в заполненном архиве`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const archive = await isolatedCreation(page);
    expect(archive.baseline.people.length).toBeGreaterThan(0);
    await page.goto(`/${route}`);
    const add = page.getByRole("button", { name: "Добавить человека", exact: true });
    await expect(add).toBeVisible();
    await expect.poll(() => add.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return rect.height >= 44 && rect.left >= 0 && rect.right <= window.innerWidth &&
        rect.bottom <= window.innerHeight && !!hit && element.contains(hit);
    })).toBe(true);
    await add.click();
    const editor = page.locator(".person-editor-form");
    await expect(editor).toBeVisible();
    await editor.getByRole("textbox", { name: /^ФИО/ }).fill("Независимов Алексей Борисович");
    await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
    await expect.poll(() => archive.saved().people.length).toBe(archive.baseline.people.length + 1);
    const added = archive.saved().people.find((person) => fullName(person) === "Независимов Алексей Борисович")!;
    expect(added.parents).toEqual([]);
    expect(added.spouses).toEqual([]);
    expect(archive.saved().links || []).toEqual(archive.baseline.links || []);
    expect(archive.saved().unions || []).toEqual(archive.baseline.unions || []);
    expect(archive.saved().people.filter((person) => person.id !== added.id)).toEqual(archive.baseline.people);
    expect(archive.writes).toHaveLength(1);
    expect(archive.writes[0].every((change) => change.collection === "people" && change.id === added.id)).toBe(true);
    await expect(editor).toHaveCount(0);
    await expect(page.getByRole("heading", { name: fullName(added), exact: true })).toBeVisible();
  });
}

test("читатель не получает создание человека ни на телефоне, ни на компьютере", async ({ page }) => {
  const archive = await isolatedCreation(page, true);
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of ["tree", "people"]) {
      await page.goto(`/${route}`);
      await expect(page).toHaveTitle(route === "tree" ? /^Древо ·/ : /^Люди ·/);
      await expect(page.getByRole("button", { name: "Добавить человека", exact: true })).toHaveCount(0);
      await expect(page.locator(".flow-add-tools")).toHaveCount(0);
      await expect(page.locator(".person-editor-form")).toHaveCount(0);
    }
  }
  expect(archive.writes).toEqual([]);
  expect(archive.saved()).toEqual(archive.baseline);
});
