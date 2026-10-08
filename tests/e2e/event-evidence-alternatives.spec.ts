import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

async function isolatedFamily(page: Page, sourceTitle: string) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  const complete = await page.request.get("/api/family");
  const full = await complete.json();
  let family = structuredClone(full.family) as Family;
  family.people.find((person) => person.id === "e2e-child")!.events = [{
    id: "legacy-alternative-event", type: "residence", date: "1901", place: "Москва",
    alternatives: [{ id: "legacy-alternative", field: "date", value: "1902",
      sources: [{ title: sourceTitle, type: "", reference: "л. 9" }] }],
  }];
  let revision = full.revision as number;
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

test("разные даты события остаются рядом с отдельными источниками", async ({ page }, info) => {
  const sourceTitle = `Адресная книга ${info.project.name}`;
  const readFamily = await isolatedFamily(page, sourceTitle);
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".event-editor > summary").click();
  const event = page.locator(".life-event-editor").last();
  await event.locator(":scope > summary").click();
  await event.getByLabel("Дата", { exact: true }).fill("1901");
  await event.getByLabel("Место", { exact: true }).fill("Москва");
  const alternatives = event.locator(".event-alternatives");
  await alternatives.locator(":scope > summary").click();
  await expect(alternatives.getByRole("button", { name: "Добавить другую дату" })).toHaveCount(0);
  const alternative = alternatives.locator(".fact-alternative").first();
  await expect(alternative.getByLabel("Другая дата события")).toHaveValue("1902");
  await expect(alternative.getByLabel("Название")).toHaveValue(sourceTitle);
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
