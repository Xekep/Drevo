import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

async function isolatedFamily(page: import("@playwright/test").Page) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  const complete = await page.request.get("/api/family");
  const full = await complete.json();
  let family = structuredClone(full.family) as Family;
  let revision = full.revision as number;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ response, json: { ...initial, family, revision } }),
  );
  await page.route("**/api/family/changes", (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    const applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    return route.fulfill({
      json: { family, revision, appliedChanges: changes },
    });
  });
  return () => family;
}

test("каталожный источник связывается с событием без оценки точной даты", async ({
  page,
}, info) => {
  const title = `Запись о переезде ${info.project.name}`;
  const source = {
    id: `event-source-${info.project.name}`,
    title,
    version: 1,
    type: "архив",
    author: "",
    institution: "",
    archive: "ГАСО",
    fond: "6",
    opis: "",
    delo: "",
    sheet: "",
    reference: "",
    url: "",
    accessedAt: "",
    description: "",
    documentIds: [],
  };
  await page.route("**/api/sources?*", (route) =>
    route.fulfill({ json: { sources: [source], total: 1 } }),
  );
  const readFamily = await isolatedFamily(page);
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".event-editor > summary").click();
  await page.getByRole("button", { name: "Добавить событие" }).click();
  const event = page.locator(".life-event-editor").last();
  await event.getByLabel("Дата", { exact: true }).fill("1901");
  await event.getByLabel("Место", { exact: true }).fill("Москва");
  await event.locator(".event-extra > summary").click();
  await event
    .getByRole("button", { name: "Добавить источник", exact: true })
    .click();
  await event
    .locator(".event-source-editor")
    .getByLabel("Источник")
    .fill("Семейная запись");
  await event.getByRole("button", { name: "Выбрать из каталога" }).click();
  await event.getByLabel("Поиск источника").fill(title);
  await event
    .locator(".union-catalog-results")
    .getByRole("button", { name: new RegExp(title) })
    .click();
  await expect(event.locator(".event-source-editor")).toHaveCount(2);
  await expect(event.locator(".event-source-editor").last()).toContainText(
    title,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect
    .poll(
      () =>
        readFamily()
          .people.find((person) => person.id === "e2e-child")
          ?.events?.find((item) => item.date === "1901")?.sources?.[1]
          ?.catalogId,
    )
    .toBe(source.id);
  const person = readFamily().people.find((item) => item.id === "e2e-child")!;
  const saved = person.events!.find((item) => item.date === "1901")!;
  expect(saved.sources?.[0].title).toBe("Семейная запись");
  expect(saved.sources?.[1].title).toBe(title);
  expect(person.birthDateClaim).toBeUndefined();
  expect(person.birthPlaceClaim).toBeUndefined();
});

test("после потери прав каталог события скрыт, ручной источник остаётся", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile");
  await isolatedFamily(page);
  await page.route("**/api/sources?*", (route) =>
    route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ error: "Нет прав" }),
    }),
  );
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".event-editor > summary").click();
  await page.getByRole("button", { name: "Добавить событие" }).click();
  const event = page.locator(".life-event-editor").last();
  await event.locator(".event-extra > summary").click();
  await event.getByRole("button", { name: "Выбрать из каталога" }).click();
  await expect(event.getByRole("alert")).toHaveText(
    "Доступ к каталогу источников изменился.",
  );
  await expect(event.locator(".union-catalog-results")).toHaveCount(0);
  await expect(
    event.getByRole("button", { name: "Добавить источник", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});
