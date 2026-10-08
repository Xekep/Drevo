import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";

const courage = { id: "ussr-medal-for-courage", name: "Медаль «За отвагу»" };
const labour = { id: "ussr-medal-veteran-labour", name: "Медаль «Ветеран труда»" };

async function isolatedAward(page: Page) {
  const response = await page.request.get("/api/family");
  const snapshot = await response.json();
  let family = structuredClone(snapshot.family) as Family;
  let revision = snapshot.revision as number;
  family.people.find((person) => person.id === "e2e-child")!.awards = [{
    id: "award-one", name: courage.name, awardDefinitionId: courage.id,
    source: { title: "Наградной лист к «За отвагу»", url: "https://example.test/courage" },
  }];
  let writes = 0;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ response, json: { ...snapshot, family, revision, partial: false } }));
  await page.route("**/api/family/changes", (route) => {
    writes++;
    const changes = route.request().postDataJSON().changes as Change[];
    const applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    return route.fulfill({ json: { family, revision, appliedChanges: changes } });
  });
  return { read: () => family.people.find((person) => person.id === "e2e-child")!.awards![0],
    readAwards: () => family.people.find((person) => person.id === "e2e-child")!.awards!,
    writes: () => writes };
}

async function openAward(page: Page) {
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const editor = page.locator(".person-editor-portrait-awards");
  await editor.getByRole("button", { name: `Редактировать: ${courage.name}` }).click();
  return editor;
}

async function chooseAward(editor: ReturnType<Page["locator"]>, name: string) {
  await editor.getByRole("combobox", { name: "Название" }).fill(name);
  await editor.getByRole("option", { name: new RegExp(name) }).click();
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
}

test("new award saves without a source; its optional source belongs only to that award", async ({ page }) => {
  const fixture = await isolatedAward(page);
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const editor = page.locator(".person-editor-portrait-awards");
  await editor.getByRole("button", { name: "Добавить награду", exact: true }).click();
  await editor.getByRole("combobox", { name: "Название" }).fill(labour.name);
  await editor.getByRole("option", { name: new RegExp(labour.name) }).click();
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Добавить", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.readAwards().length).toBe(2);
  expect(fixture.readAwards()[1].source).toBeUndefined();
  expect(fixture.read().source?.url).toBe("https://example.test/courage");

  await page.locator(".inspector-person-actions .person-edit-button").click();
  await editor.getByRole("button", { name: `Редактировать: ${labour.name}` }).click();
  await editor.locator(".award-source-editor > summary").click();
  await editor.getByLabel("Описание").fill("Удостоверение ветерана труда");
  await editor.getByLabel("Ссылка", { exact: true }).fill("https://example.test/labour");
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.readAwards()[1].source?.url).toBe("https://example.test/labour");
  expect(fixture.read().source?.url).toBe("https://example.test/courage");
});

test("changing a recognized award makes retaining its old source an explicit local choice", async ({ page }) => {
  const fixture = await isolatedAward(page);
  await page.goto("/tree");
  const editor = await openAward(page);
  await chooseAward(editor, labour.name);
  const choice = editor.getByRole("group", { name: "Источник прежней награды" });
  await expect(choice).toBeVisible();
  await expect(choice.getByRole("button", { name: "Оставить источник" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(fixture.writes()).toBe(0);
  await choice.getByRole("button", { name: "Вернуться к награде" }).press("Enter");
  await expect(editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" })).toBeFocused();
  await expect(editor.getByRole("combobox", { name: "Название" })).toHaveValue(labour.name);
  expect(fixture.read().awardDefinitionId).toBe(courage.id);
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  await choice.getByRole("button", { name: "Оставить источник" }).click();
  expect(fixture.writes()).toBe(0);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.read().awardDefinitionId).toBe(labour.id);
  expect(fixture.read().source?.url).toBe("https://example.test/courage");

  await page.locator(".inspector-person-actions .person-edit-button").click();
  const reopened = page.locator(".person-editor-portrait-awards");
  await reopened.getByRole("button", { name: `Редактировать: ${labour.name}` }).click();
  await chooseAward(reopened, courage.name);
  await reopened.getByRole("group", { name: "Источник прежней награды" })
    .getByRole("button", { name: "Убрать источник" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.read().awardDefinitionId).toBe(courage.id);
  expect(fixture.read().source).toBeUndefined();
});

test("same award identity and an explicitly changed source need no extra choice", async ({ page }) => {
  const fixture = await isolatedAward(page);
  await page.goto("/tree");
  const editor = await openAward(page);
  await editor.getByLabel("Год", { exact: true }).fill("1980");
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  await expect(editor.getByRole("group", { name: "Источник прежней награды" })).toHaveCount(0);
  expect(fixture.writes()).toBe(0);
  await editor.getByRole("button", { name: `Редактировать: ${courage.name}` }).click();
  await editor.getByRole("combobox", { name: "Название" }).fill(labour.name);
  await editor.getByRole("option", { name: new RegExp(labour.name) }).click();
  await editor.locator(".award-source-editor > summary").click();
  await editor.getByLabel("Описание").fill("Общий список наград");
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  await expect(editor.getByRole("group", { name: "Источник прежней награды" })).toHaveCount(0);
  expect(fixture.writes()).toBe(0);
});
