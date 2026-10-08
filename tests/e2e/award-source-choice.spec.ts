import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family, PersonAward, Source } from "../../src/domain/types.ts";

const courage = { id: "ussr-medal-for-courage", name: "Медаль «За отвагу»" };
const labour = { id: "ussr-medal-veteran-labour", name: "Медаль «Ветеран труда»" };

async function isolatedAward(page: Page, citations?: Source[], initial?: Partial<PersonAward>) {
  const response = await page.request.get("/api/family");
  const snapshot = await response.json();
  let family = structuredClone(snapshot.family) as Family;
  let revision = snapshot.revision as number;
  family.people.find((person) => person.id === "e2e-child")!.awards = [{
    id: "award-one", name: courage.name, awardDefinitionId: courage.id,
    source: { title: "Наградной лист к «За отвагу»", url: "https://example.test/courage" },
    ...(citations ? { sources: citations } : {}),
    ...initial,
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

async function openAward(page: Page, name = courage.name) {
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const editor = page.locator(".person-editor-portrait-awards");
  await editor.getByRole("button", { name: `Редактировать: ${name}` }).click();
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
  await editor.getByText("Описание и ссылка", { exact: true }).click();
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
  await editor.getByText("Описание и ссылка", { exact: true }).click();
  await editor.getByLabel("Описание").fill("Общий список наград");
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  await expect(editor.getByRole("group", { name: "Источник прежней награды" })).toHaveCount(0);
  expect(fixture.writes()).toBe(0);
});

test("award citations require a local retain choice when its definition changes", async ({ page }) => {
  const citation: Source = { catalogId: "award-record", title: "Наградной лист", type: "архив",
    reference: "л. 2", documentId: "d0c00000-0000-4000-8000-000000000001", documentPage: 2 };
  const fixture = await isolatedAward(page, [citation]);
  await page.goto("/tree");
  const editor = await openAward(page);
  await chooseAward(editor, labour.name);
  const choice = editor.getByRole("group", { name: "Источник прежней награды" });
  await expect(choice.getByRole("button", { name: "Оставить цитаты" })).toBeFocused();
  expect(fixture.writes()).toBe(0);
  await choice.getByRole("button", { name: "Оставить цитаты" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.read().awardDefinitionId).toBe(labour.id);
  expect(fixture.read().sources).toEqual([citation]);
  await page.locator(".inspector-person-actions .person-edit-button").click();
  const reopened = page.locator(".person-editor-portrait-awards");
  await reopened.getByRole("button", { name: `Редактировать: ${labour.name}` }).click();
  await chooseAward(reopened, courage.name);
  await reopened.getByRole("group", { name: "Источник прежней награды" })
    .getByRole("button", { name: "Убрать прежние цитаты" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.read().awardDefinitionId).toBe(courage.id);
  expect(fixture.read().sources).toEqual([]);
  expect(fixture.read().source).toBeUndefined();
});

test("catalog award citation only offers its own PDF and an administrator page control", async ({ page }) => {
  const fixture = await isolatedAward(page);
  const documentId = "d0c00000-0000-4000-8000-000000000001";
  await page.route("**/api/sources?*", (route) => route.fulfill({ json: {
    sources: [{ id: "award-record", title: "Наградная книга", type: "архив",
      author: "", institution: "", archive: "", fond: "", opis: "", delo: "",
      sheet: "", reference: "л. 2", url: "", accessedAt: "", description: "",
      documentIds: [documentId], version: 1 }], total: 1,
  } }));
  await page.route("**/api/documents?*", (route) => route.fulfill({ json: {
    items: [{ id: "f0c00000-0000-4000-8000-000000000002", title: "Чужой скан" }], total: 1,
  } }));
  await page.goto("/tree");
  const editor = await openAward(page);
  await editor.getByText("Цитаты и документы (0)", { exact: true }).click();
  await editor.getByRole("button", { name: "Выбрать из каталога" }).click();
  await editor.getByRole("button", { name: /Наградная книга/ }).click();
  await expect(editor.getByRole("link", { name: "Открыть документ источника" }))
    .toHaveAttribute("href", new RegExp(documentId));
  await expect(editor.getByRole("button", { name: "Другой документ" })).toHaveCount(0);
  await editor.getByLabel("Страница документа источника").fill("2");
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  expect(fixture.writes()).toBe(0);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.read().sources?.[0].documentPage).toBe(2);
  expect(fixture.read().sources?.[0].catalogId).toBe("award-record");
  expect(fixture.read().sources?.[0].documentId).toBe(documentId);
  expect(fixture.read().source?.url).toBe("https://example.test/courage");
});

test("each award citation keeps its document controls beside its own source", async ({ page }) => {
  if (test.info().project.name === "mobile") await page.setViewportSize({ width: 320, height: 844 });
  const firstId = "d0c00000-0000-4000-8000-000000000001";
  const secondId = "d0c00000-0000-4000-8000-000000000002";
  const fixture = await isolatedAward(page, [
    { catalogId: "first-record", title: "Первая книга", type: "архив", reference: "л. 2",
      documentId: firstId, documentPage: 2 },
    { catalogId: "second-record", title: "Вторая книга", type: "архив", reference: "л. 7",
      documentId: secondId, documentPage: 7 },
  ]);
  await page.goto("/tree");
  const editor = await openAward(page);
  await editor.getByText("Цитаты и документы (2)", { exact: true }).click();
  const first = editor.locator(".union-catalog-citation").filter({ hasText: "Первая книга" });
  const second = editor.locator(".union-catalog-citation").filter({ hasText: "Вторая книга" });
  await expect(first.getByRole("link", { name: "Открыть документ источника" }))
    .toHaveAttribute("href", new RegExp(firstId));
  await expect(second.getByRole("link", { name: "Открыть документ источника" }))
    .toHaveAttribute("href", new RegExp(secondId));
  await first.getByLabel("Страница документа источника").fill("4");
  await expect(second.getByLabel("Страница документа источника")).toHaveValue("7");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("award-citations.png") });
  expect(fixture.writes()).toBe(0);
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.read().sources?.map((source) => source.documentPage)).toEqual([4, 7]);
});

test("changing an award degree requires a choice for retained citations", async ({ page }) => {
  const fixture = await isolatedAward(page, [{ title: "Орденская запись", type: "архив",
    reference: "л. 5" }], { name: "Орден Славы", awardDefinitionId: "ussr-order-glory",
    degreeId: "1", source: undefined });
  await page.goto("/tree");
  const editor = await openAward(page, "Орден Славы");
  await editor.getByLabel("Степень").selectOption("2");
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  const choice = editor.getByRole("group", { name: "Источник прежней награды" });
  await expect(choice.getByRole("button", { name: "Оставить цитаты" })).toBeFocused();
  expect(fixture.writes()).toBe(0);
  await choice.getByRole("button", { name: "Убрать прежние цитаты" }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect.poll(() => fixture.read().degreeId).toBe("2");
  expect(fixture.read().sources).toEqual([]);
});

test("renaming a custom award requires a choice without saving on cancel", async ({ page }) => {
  const fixture = await isolatedAward(page, [{ title: "Личная запись", type: "архив",
    reference: "л. 9" }], { name: "Именная награда", awardDefinitionId: undefined,
    source: undefined });
  await page.goto("/tree");
  const editor = await openAward(page, "Именная награда");
  await editor.getByRole("combobox", { name: "Название" }).fill("Другая именная награда");
  await editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" }).click();
  const choice = editor.getByRole("group", { name: "Источник прежней награды" });
  await expect(choice.getByRole("button", { name: "Оставить цитаты" })).toBeFocused();
  await choice.getByRole("button", { name: "Вернуться к награде" }).click();
  await expect(editor.locator(".award-inline-actions").getByRole("button", { name: "Готово" })).toBeFocused();
  expect(fixture.writes()).toBe(0);
  expect(fixture.read().name).toBe("Именная награда");
});
