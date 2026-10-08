import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("сведения и события не создают привязок к полям, общий источник сохраняется отдельно", async ({ page }, info) => {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  const complete = await (await page.request.get("/api/family")).json();
  let family = structuredClone(complete.family) as Family;
  const originalAwards = structuredClone(family.people.find((person) => person.id === "e2e-child")!.awards);
  let revision = initial.revision as number;
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
  const form = page.locator(".person-editor-form");
  await expect(form.getByLabel("Фамилия при рождении", { exact: true })).toBeVisible();
  await expect(form.getByLabel("Занятие", { exact: true })).toBeVisible();
  await expect(form.locator("[data-field=birth]")).toBeVisible();
  await expect(form.locator(".birth-date-claim")).toBeHidden();
  await expect(form.locator(".fact-alternatives").first()).toBeHidden();
  await expect(form.locator(".form-details > summary").filter({ hasText: /^Источники$/ }))
    .toBeVisible();

  await form.getByLabel("Фамилия при рождении", { exact: true }).fill("Иванова");
  await form.getByLabel("Занятие", { exact: true }).fill("Учитель");
  await form.locator("[data-field=birth]").fill("1966");
  await form.getByText("ФИО и фамилия при рождении", { exact: true }).click();
  await expect(form.locator(".birth-surname-claim, .fact-alternatives")).toHaveCount(0);
  await form.getByText("Жизнь и занятия", { exact: true }).click();
  await expect(form.locator(".occupation-claim")).toHaveCount(0);
  await form.locator(".event-editor > summary").click();
  await form.getByRole("button", { name: "Добавить событие" }).click();
  const event = form.locator(".life-event-editor").last();
  await event.getByLabel("Дата", { exact: true }).fill("1991");
  await event.getByLabel("Место", { exact: true }).fill("Москва");
  await event.locator(".event-extra > summary").click();
  await expect(event.locator(".event-date-claim, .event-place-claim, .event-alternatives")).toHaveCount(0);
  await expect(event.getByRole("button", { name: "Добавить источник", exact: true })).toHaveCount(0);
  await form.locator(".form-details > summary").filter({ hasText: /^Источники$/ }).click();
  await form.getByRole("button", { name: "+ Источник", exact: true }).click();
  const source = form.locator(".source-editor").last();
  await source.getByLabel("Название", { exact: true }).fill("Семейные воспоминания");
  await source.getByLabel("Ссылка", { exact: true }).fill("https://example.test/memories");
  await source.getByLabel("Примечание", { exact: true }).fill("Общие сведения о человеке");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")?.birth)
    .toBe("1966");
  const saved = family.people.find((person) => person.id === "e2e-child")!;
  expect(saved.maidenName).toBe("Иванова");
  expect(saved.occupation).toBe("Учитель");
  expect(saved.birthDateClaim).toBeUndefined();
  expect(saved.factAlternatives || []).toEqual([]);
  expect(saved.awards).toEqual(originalAwards);
  expect(saved.sources.at(-1)).toEqual(expect.objectContaining({
    title: "Семейные воспоминания", url: "https://example.test/memories", note: "Общие сведения о человеке",
  }));
  expect(saved.events?.at(-1)).toEqual(expect.objectContaining({ date: "1991", place: "Москва" }));
  expect(saved.events?.at(-1)?.sources).toBeUndefined();
  expect(saved.events?.at(-1)?.dateClaim).toBeUndefined();
  expect(saved.events?.at(-1)?.placeClaim).toBeUndefined();

  await page.locator(".inspector-person-actions .person-edit-button").click();
  await expect(form.getByLabel("Занятие", { exact: true })).toHaveValue("Учитель");
  await expect(form.locator(".person-evidence-details")).toHaveCount(0);
  await form.locator("[data-field=birth]").fill("1967");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")?.birth).toBe("1967");
  expect(family.people.find((person) => person.id === "e2e-child")?.sources).toEqual(saved.sources);
  await page.locator(".inspector-person-actions .person-edit-button").click();
  if (info.project.name === "mobile") await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  await page.screenshot({ path: info.outputPath("person-evidence-simple.png") });
});
