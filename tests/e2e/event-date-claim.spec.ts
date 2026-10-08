import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

async function isolatedFamily(page: Page, title: string) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  const complete = await page.request.get("/api/family");
  const full = await complete.json();
  let family = structuredClone(full.family) as Family;
  family.people.find((item) => item.id === "e2e-child")!.events = [{
    id: "legacy-event", type: "residence", date: "1909-01-01",
    dateClaim: { value: "1909-01-01", sources: [{ title, type: "", reference: "л. 8" }] },
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

test("источник точной даты события не переносится на новую дату", async ({ page }, info) => {
  const title = `Ведомость даты ${info.project.name}`;
  const readFamily = await isolatedFamily(page, title);
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".event-editor > summary").click();
  const event = page.locator(".life-event-editor").last();
  await event.locator(":scope > summary").click();
  await event.getByLabel("Дата", { exact: true }).fill("1.1.1909");
  const claim = event.locator(".event-date-claim");
  await claim.locator(":scope > summary").click();
  await expect(claim.getByLabel("Название")).toHaveValue(title);
  await claim.getByLabel("Достоверность").selectOption("probable");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => readFamily().people.find((person) => person.id === "e2e-child")
    ?.events?.find((item) => item.dateClaim?.sources[0].title === title)?.dateClaim?.value)
    .toBe("1909-01-01");
  const savedEvent = readFamily().people.find((person) => person.id === "e2e-child")!
    .events!.find((item) => item.dateClaim?.sources[0].title === title)!;
  expect(savedEvent.date).toBe("1909-01-01");
  expect(savedEvent.sources).toBeUndefined();
  expect(savedEvent.dateClaim?.sources[0].reference).toBe("л. 8");
  expect(savedEvent.dateClaim?.confidence).toBe("probable");

  await page.locator(".inspector-person-actions .person-edit-button").click();
  const section = page.locator(".event-editor");
  if (!(await section.evaluate((element) => (element as HTMLDetailsElement).open)))
    await section.locator(":scope > summary").click();
  const reopened = page.locator(".life-event-editor").filter({ hasText: "1909" });
  await reopened.locator(":scope > summary").click();
  await reopened.getByLabel("Дата", { exact: true }).fill("2.1.1909");
  const oldClaim = reopened.locator(".event-date-claim");
  await oldClaim.locator(":scope > summary").click();
  await expect(oldClaim.getByRole("alert")).toContainText("Источники относятся к прежней дате 01.01.1909");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByText("Источник даты события относится к другому значению", { exact: false })).toBeVisible();
  expect(readFamily().people.find((person) => person.id === "e2e-child")!
    .events!.find((item) => item.id === savedEvent.id)!.date).toBe("1909-01-01");
  await oldClaim.getByRole("button", { name: "Снять связи с прежней датой" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => readFamily().people.find((person) => person.id === "e2e-child")
    ?.events?.find((item) => item.id === savedEvent.id)?.date).toBe("1909-01-02");
  expect(readFamily().people.find((person) => person.id === "e2e-child")!
    .events!.find((item) => item.id === savedEvent.id)!.dateClaim).toBeUndefined();
});
