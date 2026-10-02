import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

async function isolatedFamily(page: Page) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  const complete = await page.request.get("/api/family");
  const full = await complete.json();
  let family = structuredClone(full.family) as Family;
  let revision = full.revision as number;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ response, json: { ...initial, family, revision } }));
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

test("разные даты события остаются рядом с отдельными источниками", async ({ page }, info) => {
  const readFamily = await isolatedFamily(page);
  const sourceTitle = `Адресная книга ${info.project.name}`;
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".event-editor > summary").click();
  await page.getByRole("button", { name: "Добавить событие" }).click();
  const event = page.locator(".life-event-editor").last();
  await event.getByLabel("Дата", { exact: true }).fill("1901");
  await event.getByLabel("Место", { exact: true }).fill("Москва");
  const alternatives = event.locator(".event-alternatives");
  await alternatives.locator(":scope > summary").click();
  await alternatives.getByRole("button", { name: "Добавить другую дату" }).click();
  const alternative = alternatives.locator(".fact-alternative").first();
  await alternative.getByLabel("Другая дата события").fill("1902");
  await alternative.getByRole("button", { name: "Добавить источник вручную" }).click();
  await alternative.getByLabel("Название").fill(sourceTitle);
  await alternative.getByLabel("Ссылка в источнике").fill("л. 9");
  await alternative.getByLabel("Достоверность").selectOption("probable");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => readFamily().people.find((person) => person.id === "e2e-child")
    ?.events?.find((item) => item.alternatives?.[0].sources[0].title === sourceTitle)
    ?.alternatives?.[0].value).toBe("1902");
  const saved = readFamily().people.find((person) => person.id === "e2e-child")!
    .events!.find((item) => item.alternatives?.[0].sources[0].title === sourceTitle)!;
  expect(saved.date).toBe("1901");
  expect(saved.place).toBe("Москва");
  expect(saved.alternatives?.[0].confidence).toBe("probable");
  await expect(page.locator(".person-events")).toContainText("Другие записи в источниках");
  await expect(page.locator(".person-events")).toContainText(sourceTitle);
});
