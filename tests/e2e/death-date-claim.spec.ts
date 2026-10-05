import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("каталожный источник относится к дате смерти и не переносится на новую дату", async ({ page }, info) => {
  const title = `Запись о смерти ${info.project.name}`;
  const source = { id: `death-claim-${info.project.name}`, title, version: 1,
    type: "архив", author: "", institution: "", archive: "ГАСО", fond: "6",
    opis: "", delo: "", sheet: "", reference: "", url: "", accessedAt: "",
    description: "", documentIds: [] };
  await page.route("**/api/sources?*", async (route) =>
    route.fulfill({ json: { sources: [source], total: 1 } }));
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  let family = structuredClone(initial.family) as Family;
  let revision = initial.revision as number;
  await page.route("**/api/family?projection=overview", async (route) =>
    route.fulfill({ response, json: { ...initial, family, revision } }));
  await page.route("**/api/family/changes", async (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    family = applyArchiveChanges(family, changes).family;
    revision++;
    await route.fulfill({ json: { family, revision, appliedChanges: changes } });
  });
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("Точные источники и варианты смерти").click();
  await page.getByText("Источники даты смерти").click();
  const claim = page.locator(".death-date-claim");
  await claim.getByRole("button", { name: "Выбрать из каталога" }).click();
  await claim.getByLabel("Поиск источника").fill(title);
  await claim.locator(".union-catalog-results").getByRole("button", { name: title }).click();
  await expect(claim.getByRole("combobox", { name: /Достоверность/ })).toHaveValue("");
  await claim.getByRole("combobox", { name: /Достоверность/ }).selectOption("probable");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-memorial-person")?.deathDateClaim?.sources[0].catalogId)
    .toBe(source.id);
  const person = family.people.find((item) => item.id === "e2e-memorial-person")!;
  expect(person.deathDateClaim?.value).toBe(person.death);
  expect(person.deathDateClaim?.confidence).toBe("probable");
  await expect(page.getByText(`Источники даты: ${title} · Оценка: Вероятно`)).toBeVisible();

  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".person-date-group").last().locator(".person-evidence-details > summary").click();
  await page.locator(".death-date-claim > summary").click();
  await page.locator("[data-field=death]").fill("2021");
  await expect(page.getByRole("alert").filter({ hasText: "Источники относятся к прежней дате" })).toBeVisible();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText(/Источник даты смерти относится к другому значению/)).toBeVisible();
  await page.getByRole("button", { name: "Снять связи с прежней датой" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((item) => item.id === "e2e-memorial-person")?.death).toBe("2021");
  expect(family.people.find((item) => item.id === "e2e-memorial-person")?.deathDateClaim).toBeUndefined();
});
