import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("обычные сведения сохраняются без источника, а точные связи открываются отдельно", async ({ page }, info) => {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  let family = structuredClone(initial.family) as Family;
  let revision = initial.revision as number;
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
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.people.find((person) => person.id === "e2e-child")?.birth)
    .toBe("1966");
  const saved = family.people.find((person) => person.id === "e2e-child")!;
  expect(saved.maidenName).toBe("Иванова");
  expect(saved.occupation).toBe("Учитель");
  expect(saved.birthDateClaim).toBeUndefined();
  expect(saved.factAlternatives || []).toEqual([]);

  await page.locator(".inspector-person-actions .person-edit-button").click();
  await expect(form.getByLabel("Занятие", { exact: true })).toHaveValue("Учитель");
  await form.locator(".person-date-group").first().locator(".person-evidence-details > summary").click();
  await expect(form.locator(".birth-date-claim")).toBeVisible();
  if (info.project.name === "mobile") await page.setViewportSize({ width: 320, height: 720 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
    .toBe(true);
  await page.screenshot({ path: info.outputPath("person-evidence-simple.png") });
});
