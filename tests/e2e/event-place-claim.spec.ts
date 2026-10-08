import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

async function isolatedFamily(page: Page, title: string) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  const complete = await page.request.get("/api/family");
  const full = await complete.json();
  let family = structuredClone(full.family) as Family;
  family.people.find((person) => person.id === "e2e-child")!.events = [{
    id: "legacy-place-event", type: "residence", date: "1909", place: "Москва",
    placeClaim: { value: "Москва", sources: [{ title, type: "", reference: "л. 7" }] },
  }];
  let revision = full.revision as number;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ response, json: { ...initial, family, revision, partial: false } }),
  );
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

test("источник точного места события сохраняется и не переносится при смене места", async ({ page }, info) => {
  const title = `Перепись места события ${info.project.name}`;
  const readFamily = await isolatedFamily(page, title);
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".event-editor > summary").click();
  const event = page.locator(".life-event-editor").last();
  await event.locator(":scope > summary").click();
  await event.getByLabel("Дата", { exact: true }).fill("1909");
  await event.getByLabel("Место", { exact: true }).fill("Москва");
  const claim = event.locator(".event-place-claim");
  await claim.locator(":scope > summary").click();
  await expect(claim.getByLabel("Название")).toHaveValue(title);
  await expect(claim.getByRole("button", { name: "Добавить источник вручную" })).toHaveCount(0);
  await claim.getByLabel("Достоверность").selectOption("conflicting");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => readFamily().people.find((person) => person.id === "e2e-child")
    ?.events?.find((item) => item.placeClaim?.sources[0].title === title)?.placeClaim?.value)
    .toBe("Москва");
  const savedEvent = readFamily().people.find((person) => person.id === "e2e-child")!
    .events!.find((item) => item.placeClaim?.sources[0].title === title)!;
  expect(savedEvent.sources).toBeUndefined();
  expect(savedEvent.placeClaim?.sources[0].reference).toBe("л. 7");
  expect(savedEvent.placeClaim?.confidence).toBe("conflicting");

  await page.locator(".inspector-person-actions .person-edit-button").click();
  const section = page.locator(".event-editor");
  if (!(await section.evaluate((element) => (element as HTMLDetailsElement).open)))
    await section.locator(":scope > summary").click();
  const reopened = page.locator(".life-event-editor").filter({ hasText: "1909" });
  await reopened.locator(":scope > summary").click();
  await reopened.getByLabel("Место", { exact: true }).fill("Казань");
  const oldClaim = reopened.locator(".event-place-claim");
  await oldClaim.locator(":scope > summary").click();
  await expect(oldClaim.getByRole("alert")).toContainText("Источники относятся к прежнему месту Москва");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Источник места события относится к другому значению", { exact: false })).toBeVisible();
  expect(readFamily().people.find((person) => person.id === "e2e-child")!
    .events!.find((item) => item.id === savedEvent.id)!.place).toBe("Москва");
  await oldClaim.getByRole("button", { name: "Снять связи с прежним местом" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => readFamily().people.find((person) => person.id === "e2e-child")
    ?.events?.find((item) => item.id === savedEvent.id)?.place).toBe("Казань");
  expect(readFamily().people.find((person) => person.id === "e2e-child")!
    .events!.find((item) => item.id === savedEvent.id)!.placeClaim).toBeUndefined();
});
