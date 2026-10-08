import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

async function isolatedFamily(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/family");
  const initial = await response.json();
  let family = structuredClone(initial.family) as Family;
  let revision = initial.revision as number;
  // Imported event citations survive the simpler editor.
  family.people.find((person) => person.id === "e2e-child")!.events = [{
    id: "legacy-source-event", type: "residence", date: "1901", place: "Москва",
    sources: [{ title: "Семейная запись", type: "", reference: "" }],
  }];
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ response, json: { ...initial, family, revision, partial: false } }));
  await page.route("**/api/family/changes", (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    const applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    return route.fulfill({ json: { family, revision, appliedChanges: changes } });
  });
  return () => family;
}

test("каталожный источник добавляется ко всей карточке, прежний источник события сохраняется", async ({ page }, info) => {
  const title = `Запись о переезде ${info.project.name}`;
  const source = { id: `general-source-${info.project.name}`, title, version: 1,
    type: "архив", author: "", institution: "", archive: "ГАСО", fond: "6",
    opis: "", delo: "", sheet: "", reference: "", url: "", accessedAt: "",
    description: "", documentIds: [] };
  await page.route("**/api/sources?*", (route) => route.fulfill({ json: { sources: [source], total: 1 } }));
  const readFamily = await isolatedFamily(page);
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const form = page.locator(".person-editor-form");
  const section = form.locator(".form-details").filter({ has: page.locator(".form-details > summary").filter({ hasText: /^Источники$/ }) }).last();
  await section.locator(":scope > summary").click();
  await section.getByRole("button", { name: "Выбрать из каталога" }).click();
  await section.getByLabel("Поиск источника").fill(title);
  await section.locator(".union-catalog-results").getByRole("button", { name: new RegExp(title) }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => readFamily().people.find((person) => person.id === "e2e-child")?.sources.at(-1)?.catalogId).toBe(source.id);
  expect(readFamily().people.find((person) => person.id === "e2e-child")?.events?.[0].sources?.[0].title).toBe("Семейная запись");

  await page.locator(".inspector-person-actions .person-edit-button").click();
  await form.locator(".event-editor > summary").click();
  const event = form.locator(".life-event-editor").first();
  await event.locator(":scope > summary").click();
  await event.locator(".event-extra > summary").click();
  await expect(event.getByLabel("Источник", { exact: true })).toHaveValue("Семейная запись");
  await expect(event.getByRole("button", { name: "Добавить источник", exact: true })).toHaveCount(0);
  await event.getByLabel("Событие").selectOption("military");
  await expect(event.getByRole("status")).toContainText("из черновика сняты данные прежнего события");
  await expect(event.locator(".event-source-editor")).toHaveCount(0);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => readFamily().people.find((person) => person.id === "e2e-child")?.events?.[0].type).toBe("military");
  expect(readFamily().people.find((person) => person.id === "e2e-child")?.events?.[0].sources).toBeUndefined();
  expect(readFamily().people.find((person) => person.id === "e2e-child")?.sources.at(-1)?.catalogId).toBe(source.id);
});

test("при потере прав на общий каталог ручной источник остаётся доступен", async ({ page }) => {
  await isolatedFamily(page);
  await page.route("**/api/sources?*", (route) => route.fulfill({ status: 403, json: { error: "Нет прав" } }));
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const form = page.locator(".person-editor-form");
  await form.locator(".form-details > summary").filter({ hasText: /^Источники$/ }).click();
  await form.getByRole("button", { name: "Выбрать из каталога" }).click();
  await expect(form.getByRole("alert")).toHaveText("Доступ к каталогу источников изменился.");
  await expect(form.locator(".union-catalog-results")).toHaveCount(0);
  await expect(form.getByRole("button", { name: "+ Источник", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
