import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("прежняя другая запись о рождении сохраняет собственный источник", async ({ page }) => {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  let family = structuredClone(initial.family) as Family;
  family.people.find((item) => item.id === "e2e-child")!.factAlternatives = [{
    id: "legacy-birth", field: "birth", value: "1966",
    sources: [{ title: "Вторая запись о рождении", type: "Архив", reference: "л. 2" }],
  }];
  let revision = initial.revision as number;
  await page.route("**/api/family?projection=overview", async (route) =>
    route.fulfill({ response, json: { ...initial, family, revision, partial: false } }));
  await page.route("**/api/family/changes", async (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    family = applyArchiveChanges(family, changes).family;
    revision++;
    await route.fulfill({ json: { family, revision, appliedChanges: changes } });
  });
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("Точные источники и варианты рождения").click();
  const alternatives = page.locator(".fact-alternatives").first();
  await alternatives.locator("summary").click();
  await expect(alternatives.getByRole("button", { name: "Добавить другую дату" })).toHaveCount(0);
  const variant = alternatives.locator(".fact-alternative");
  await expect(variant.getByLabel("Другая дата рождения")).toHaveValue("1966");
  await expect(variant.getByLabel("Название")).toHaveValue("Вторая запись о рождении");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")
    ?.factAlternatives?.[0].value).toBe("1966");
  const stored = family.people.find((person) => person.id === "e2e-child")!;
  expect(stored.factAlternatives?.[0].sources[0].title).toBe("Вторая запись о рождении");
  expect(stored.birth).not.toBe("1966");
  await expect(page.getByText(/Другая дата рождения: 1966.*Вторая запись о рождении/))
    .toBeVisible();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".person-date-group").first().locator(".person-evidence-details > summary").click();
  const saved = page.locator(".fact-alternatives").first();
  await saved.locator("summary").click();
  await expect(saved.getByLabel("Другая дата рождения")).toHaveAttribute("readonly", "");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
});

test("источник прежней фамилии при рождении остаётся рядом с новым значением", async ({ page }) => {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  let family = structuredClone(initial.family) as Family;
  const legacyPerson = family.people.find((item) => item.id === "e2e-child")!;
  legacyPerson.maidenName = "Иванова";
  legacyPerson.maidenNameClaim = { value: "Иванова",
    sources: [{ title: "Первая метрическая книга", type: "Архив", reference: "л. 7" }] };
  let revision = initial.revision as number;
  await page.route("**/api/family?projection=overview", async (route) =>
    route.fulfill({ response, json: { ...initial, family, revision, partial: false } }));
  await page.route("**/api/family/changes", async (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    const applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    await route.fulfill({ json: { family, revision, appliedChanges: changes } });
  });
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("ФИО и фамилия при рождении", { exact: true }).click();
  await page.getByLabel("Фамилия при рождении", { exact: true }).fill("Иванова");
  const claim = page.locator(".birth-surname-claim");
  await claim.locator("summary").click();
  await expect(claim.getByLabel("Название")).toHaveValue("Первая метрическая книга");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")
    ?.maidenNameClaim?.value).toBe("Иванова");

  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("ФИО и фамилия при рождении", { exact: true }).click();
  await page.getByLabel("Фамилия при рождении", { exact: true }).fill("Петрова");
  await page.locator(".birth-surname-claim > summary").click();
  await page.getByRole("button", { name: "Сохранить прежнюю фамилию с источниками как вариант" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")
    ?.factAlternatives?.[0].value).toBe("Иванова");
  const stored = family.people.find((person) => person.id === "e2e-child")!;
  expect(stored.maidenName).toBe("Петрова");
  expect(stored.maidenNameClaim).toBeUndefined();
  expect(stored.factAlternatives?.[0].sources[0].title).toBe("Первая метрическая книга");
  await expect(page.getByText(/Другая фамилия при рождении: Иванова.*Первая метрическая книга/))
    .toBeVisible();
});
