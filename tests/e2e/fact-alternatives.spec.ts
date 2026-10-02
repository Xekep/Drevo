import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("другую запись о рождении можно сохранить с собственным источником", async ({ page }) => {
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
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const alternatives = page.locator(".fact-alternatives").first();
  await alternatives.locator("summary").click();
  await alternatives.getByRole("button", { name: "Добавить другую дату" }).click();
  const variant = alternatives.locator(".fact-alternative");
  await variant.getByLabel("Другая дата рождения").fill("1966");
  await variant.getByRole("button", { name: "Добавить источник вручную" }).click();
  await variant.getByLabel("Название").fill("Вторая запись о рождении");
  await variant.getByLabel("Тип").fill("Архив");
  await variant.getByLabel("Ссылка в источнике").fill("л. 2");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")
    ?.factAlternatives?.[0].value).toBe("1966");
  const stored = family.people.find((person) => person.id === "e2e-child")!;
  expect(stored.factAlternatives?.[0].sources[0].title).toBe("Вторая запись о рождении");
  expect(stored.birth).not.toBe("1966");
  await expect(page.getByText(/Другая дата рождения: 1966.*Вторая запись о рождении/))
    .toBeVisible();
  await page.locator(".inspector-person-actions .person-edit-button").click();
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
  let revision = initial.revision as number;
  await page.route("**/api/family?projection=overview", async (route) =>
    route.fulfill({ response, json: { ...initial, family, revision } }));
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
  await claim.getByRole("button", { name: "Добавить источник вручную" }).click();
  await claim.getByLabel("Название").fill("Первая метрическая книга");
  await claim.getByLabel("Тип").fill("Архив");
  await claim.getByLabel("Ссылка в источнике").fill("л. 7");
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
