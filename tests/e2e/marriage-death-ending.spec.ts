import { expect, test } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

test("saving a spouse's death saves the marriage ending in the same change", async ({ page, isMobile }) => {
  test.skip(isMobile);
  const response = await page.request.get("/api/family");
  const snapshot = await response.json();
  let family = structuredClone(snapshot.family) as Family;
  for (const id of ["e2e-child", "e2e-spouse"]) {
    const person = family.people.find(person => person.id === id)!;
    person.death = undefined;
    person.deceased = false;
    person.deathPlace = "";
  }
  family.unions = [{ id: "death-ending", type: "marriage",
    participants: ["e2e-child", "e2e-spouse"], formation: { date: "2000" } }];
  let revision = snapshot.revision;
  const writes: Change[][] = [];
  await page.route("**/api/family?projection=overview", route => route.fulfill({
    json: { ...snapshot, family, revision, partial: false },
  }));
  await page.route("**/api/family/changes", route => {
    const changes = route.request().postDataJSON().changes as Change[];
    const result = applyArchiveChanges(family, changes);
    expect(result.conflicts).toEqual([]);
    family = result.family;
    writes.push(changes);
    return route.fulfill({ json: { family, revision: ++revision, appliedChanges: changes } });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/people/e2e-child");
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const form = page.locator(".person-editor-form");
  await form.locator("[data-field=death]").fill("2020");
  await form.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => family.unions![0].ending?.date).toBe("2020");
  expect(writes).toHaveLength(1);
  expect(writes[0].map(change => change.collection)).toEqual(expect.arrayContaining(["people", "unions"]));
  await expect(page.locator(".inspector-dock .person-unions")).toContainText("2020 год");
});
