import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("прежний источник фамилии при рождении связан только с указанной фамилией", async ({ page }, info) => {
  const title = `Метрическая книга ${info.project.name}`;
  const source = { id: `birth-surname-${info.project.name}`, title, version: 1,
    type: "архив", author: "", institution: "", archive: "ГАСО", fond: "6",
    opis: "", delo: "", sheet: "", reference: "", url: "", accessedAt: "",
    description: "", documentIds: [] };
  await page.route("**/api/sources?*", (route) =>
    route.fulfill({ json: { sources: [source], total: 1 } }));
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  const complete = await page.request.get("/api/family");
  const full = await complete.json();
  let family = structuredClone(full.family) as Family;
  const legacyPerson = family.people.find((item) => item.id === "e2e-child")!;
  legacyPerson.maidenName = "Иванова";
  legacyPerson.maidenNameClaim = { value: "Иванова",
    sources: [{ catalogId: source.id, title, type: "архив", reference: "" }] };
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

  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("ФИО и фамилия при рождении", { exact: true }).click();
  await page.getByLabel("Фамилия при рождении", { exact: true }).fill("Иванова");
  const claim = page.locator(".birth-surname-claim");
  await claim.locator("summary").click();
  await expect(claim.getByRole("button", { name: "Выбрать из каталога" })).toHaveCount(0);
  await expect(claim.getByRole("combobox", { name: /Достоверность/ })).toHaveValue("");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")
    ?.maidenNameClaim?.sources[0].catalogId).toBe(source.id);
  expect(family.people.find((person) => person.id === "e2e-child")?.maidenNameClaim?.value)
    .toBe("Иванова");
  await expect(page.getByText(`Источники фамилии при рождении: ${title}`)).toBeVisible();

  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("ФИО и фамилия при рождении", { exact: true }).click();
  await page.locator(".birth-surname-claim > summary").click();
  await page.getByLabel("Фамилия при рождении", { exact: true }).fill("Сидорова");
  await expect(page.getByRole("alert").filter({ hasText: "Источники относятся к прежней фамилии" })).toBeVisible();
  await page.getByRole("button", { name: "Снять связи с прежней фамилией" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")?.maidenName)
    .toBe("Сидорова");
  expect(family.people.find((person) => person.id === "e2e-child")?.maidenNameClaim)
    .toBeUndefined();
});
