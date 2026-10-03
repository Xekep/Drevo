import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family, FamilyUnion } from "../../src/domain/types.ts";

async function isolatedFamily(page: Page, addedUnions: FamilyUnion[] = []) {
  const response = await page.request.get("/api/family?projection=overview");
  const initial = await response.json();
  let family: Family = structuredClone(initial.family);
  family.unions = [...(family.unions || []), ...addedUnions];
  let revision = initial.revision as number;

  await page.route("**/api/family?projection=overview", async (route) => {
    await route.fulfill({ response, json: { ...initial, family, revision } });
  });
  await page.route("**/api/family/changes", async (route) => {
    const changes = route.request().postDataJSON().changes as Change[];
    family = applyArchiveChanges(family, changes).family;
    revision++;
    await route.fulfill({ json: { family, revision, appliedChanges: changes } });
  });
  return () => family;
}

let createdSource: { id: string; version: number } | undefined;
test.afterEach(async ({ page }) => {
  if (!createdSource) return;
  const source = createdSource;
  createdSource = undefined;
  const deleted = await page.request.delete(`/api/sources/${source.id}`, {
    data: { version: source.version },
  });
  expect(deleted.status()).toBe(200);
});

test("источник каталога подтверждает союз и его этапы", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const title = `Запись о браке ${info.project.name}`;
  const created = await page.request.post("/api/sources", { data: { title, archive: "ГАСО", fond: "6" } });
  expect(created.status()).toBe(201);
  createdSource = (await created.json()).source;
  const sourceId = createdSource!.id;
  const readFamily = await isolatedFamily(page);

  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  const edge = page.getByRole("group", { name: "Тестов Пётр Иванович — Тестова Елена Сергеевна" });
  await edge.focus();
  await edge.press("Enter");
  const panel = page.getByRole("region", { name: "Семейные союзы" });
  await expect(panel).toBeVisible();
  await panel.getByRole("button", { name: "Добавить союз" }).click();

  async function choose(scope: typeof panel) {
    await scope.getByRole("button", { name: "Выбрать из каталога" }).click();
    await scope.getByLabel("Поиск источника").fill(title);
    await scope.locator(".union-catalog-results").getByRole("button", { name: new RegExp(title) }).click();
  }
  const unionSources = panel.getByRole("group", { name: "Источники союза" });
  await choose(unionSources);
  await unionSources.getByRole("button", { name: "Добавить источник вручную" }).click();
  const inline = unionSources.locator(".union-inline-citation");
  await inline.getByLabel("Название").fill("Семейное предание");
  await inline.getByLabel("Тип").fill("устный");
  await inline.getByLabel("Ссылка в источнике").fill("запись беседы");
  const formation = panel.getByRole("group", { name: "Заключение" });
  await formation.getByLabel("Статус достоверности этапа").selectOption("probable");
  await formation.getByText("Источники этапа (0)").click();
  await choose(formation);
  const divorce = panel.getByRole("group", { name: "Развод" });
  await divorce.getByLabel("Статус достоверности этапа").selectOption("conflicting");
  await divorce.getByText("Источники этапа (0)").click();
  await choose(divorce);
  await panel.getByRole("button", { name: "Сохранить союз" }).click();

  const union = readFamily().unions!.find((item: { participants: string[]; sources?: { catalogId?: string }[] }) =>
    item.participants.includes("e2e-child") && item.participants.includes("e2e-spouse") &&
    item.sources?.some((source: { catalogId?: string }) => source.catalogId === sourceId))!;
  expect(union.sources![0].catalogId).toBe(sourceId);
  expect(union.sources![1].title).toBe("Семейное предание");
  expect(union.formation!.sources![0].catalogId).toBe(sourceId);
  expect(union.formation!.confidence).toBe("probable");
  expect(union.divorce!.sources![0].catalogId).toBe(sourceId);
  expect(union.divorce!.confidence).toBe("conflicting");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("уточнение даты этапа снимает его оценку перед сохранением", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const id = crypto.randomUUID();
  const readFamily = await isolatedFamily(page, [{
    id, participants: ["e2e-child", "e2e-spouse"], type: "marriage",
    formation: { date: "1920", confidence: "confirmed" },
  }]);
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  const edge = page.getByRole("group", { name: "Тестов Пётр Иванович — Тестова Елена Сергеевна" });
  await edge.focus();
  await edge.press("Enter");
  const panel = page.getByRole("region", { name: "Семейные союзы" });
  await panel.locator(".event-card").filter({ hasText: "1920" })
    .getByRole("button", { name: "Изменить союз" }).click();
  const formation = panel.getByRole("group", { name: "Заключение" });
  await expect(formation.getByLabel("Статус достоверности этапа")).toHaveValue("confirmed");
  await formation.getByLabel("Дата (год, месяц или день)").fill("1921");
  await expect(formation.getByLabel("Статус достоверности этапа")).toHaveCount(0);
  await expect(formation).toContainText("Сначала сохраните изменённый союз, затем оцените этап заново");
  await expect(panel.getByRole("status")).toContainText("Оценка достоверности прежнего этапа снята");
  await panel.getByRole("button", { name: "Сохранить союз" }).click();
  const saved = readFamily().unions!.find((union) => union.id === id)!.formation!;
  expect(saved.date).toBe("1921");
  expect(saved.confidence).toBeUndefined();
  await panel.locator(".event-card").filter({ hasText: "1921" })
    .getByRole("button", { name: "Изменить союз" }).click();
  await formation.getByLabel("Статус достоверности этапа").selectOption("probable");
  await panel.getByRole("button", { name: "Сохранить союз" }).click();
  expect(readFamily().unions!.find((union) => union.id === id)!.formation!.confidence).toBe("probable");
});

test("мобильный picker скрывает каталог после потери прав", async ({ page }, info) => {
  test.skip(info.project.name !== "mobile");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  const edge = page.getByRole("group", { name: "Тестов Пётр Иванович — Тестова Елена Сергеевна" });
  await edge.focus();
  await edge.press("Enter");
  const panel = page.getByRole("region", { name: "Семейные союзы" });
  await panel.getByRole("button", { name: "Добавить союз" }).click();
  await page.route("**/api/sources?*", (route) => route.fulfill({ status: 403,
    contentType: "application/json", body: JSON.stringify({ error: "Нет прав" }) }));
  const unionSources = panel.getByRole("group", { name: "Источники союза" });
  await unionSources.getByRole("button", { name: "Выбрать из каталога" }).click();
  await expect(unionSources.getByRole("alert")).toHaveText("Доступ к каталогу источников изменился.");
  await expect(unionSources.locator(".union-catalog-results")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});

test("источник противоположного этапа не стирает развод или окончание", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const created = await page.request.post("/api/sources", { data: { title: "Акт о завершении союза" } });
  expect(created.status()).toBe(201);
  const source = (await created.json()).source;
  createdSource = source;
  const citation = { catalogId: source.id, title: source.title, type: "", reference: "" };
  const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
  const readFamily = await isolatedFamily(page, [
    { id: firstId, participants: ["e2e-child", "e2e-spouse"], type: "marriage",
      divorce: { date: "1930", sources: [citation] } },
    { id: secondId, participants: ["e2e-child", "e2e-spouse"], type: "marriage",
      ending: { date: "1980", sources: [citation] } },
  ]);
  await page.goto("/tree");
  const openPanel = async () => {
    await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
    const edge = page.getByRole("group", { name: "Тестов Пётр Иванович — Тестова Елена Сергеевна" });
    await edge.focus();
    await edge.press("Enter");
    return page.getByRole("region", { name: "Семейные союзы" });
  };
  let panel = await openPanel();
  await panel.locator(".event-card").filter({ hasText: "1930" }).getByRole("button", { name: "Изменить союз" }).click();
  await expect(panel.getByRole("group", { name: "Окончание" })).toContainText("Источники можно добавить после выбора этого этапа");
  await expect(panel.getByRole("group", { name: "Окончание" }).getByRole("button", { name: "Выбрать из каталога" })).toHaveCount(0);
  await panel.getByLabel("Примечание").fill("Проверка развода");
  await panel.getByRole("button", { name: "Сохранить союз" }).click();
  expect(readFamily().unions!.find((union) => union.id === firstId)!.divorce!.sources![0].catalogId).toBe(source.id);

  panel = await openPanel();
  await panel.locator(".event-card").filter({ hasText: "1980" }).getByRole("button", { name: "Изменить союз" }).click();
  await expect(panel.getByRole("group", { name: "Развод" })).toContainText("Источники можно добавить после выбора этого этапа");
  await expect(panel.getByRole("group", { name: "Развод" }).getByRole("button", { name: "Выбрать из каталога" })).toHaveCount(0);
  await panel.getByLabel("Примечание").fill("Проверка окончания");
  await panel.getByRole("button", { name: "Сохранить союз" }).click();
  expect(readFamily().unions!.find((union) => union.id === secondId)!.ending!.sources![0].catalogId).toBe(source.id);
});

test("смена типа союза явно снимает старые источники и позволяет добавить новые после сохранения", async ({ page }) => {
  const id = crypto.randomUUID();
  const oldSource = { title: "Акт брака", type: "архив", reference: "л. 2" };
  const readFamily = await isolatedFamily(page, [{
    id, participants: ["e2e-child", "e2e-spouse"], type: "marriage",
    note: "Семейная история", sources: [oldSource],
    formation: { date: "1900", place: "Тула", sources: [oldSource] },
  }]);
  await page.goto("/tree");
  const openPanel = async () => {
    await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
    const edge = page.getByRole("group", { name: "Тестов Пётр Иванович — Тестова Елена Сергеевна" });
    await edge.focus();
    await edge.press("Enter");
    return page.getByRole("region", { name: "Семейные союзы" });
  };
  let panel = await openPanel();
  await panel.locator(".event-card").filter({ hasText: "1900" })
    .getByRole("button", { name: "Изменить союз" }).click();
  await panel.getByLabel("Тип союза").selectOption("partnership");
  await expect(panel.getByRole("status")).toContainText("Прежние источники союза и его этапов сняты");
  await expect(panel.getByRole("group", { name: "Источники союза" })).toContainText(
    "Сначала сохраните новый тип союза");
  await panel.getByRole("button", { name: "Сохранить союз" }).click();
  const changed = readFamily().unions!.find((union) => union.id === id)!;
  expect(changed.type).toBe("partnership");
  expect(changed.sources).toBeUndefined();
  expect(changed.formation?.sources).toBeUndefined();
  expect(changed.formation?.date).toBe("1900");
  expect(changed.formation?.place).toBe("Тула");
  expect(changed.note).toBe("Семейная история");

  panel = await openPanel();
  await panel.locator(".event-card").filter({ hasText: "1900" })
    .getByRole("button", { name: "Изменить союз" }).click();
  const sources = panel.getByRole("group", { name: "Источники союза" });
  await sources.getByRole("button", { name: "Добавить источник вручную" }).click();
  const inline = sources.locator(".union-inline-citation");
  await inline.getByLabel("Название").fill("Запись о партнёрстве");
  await inline.getByLabel("Тип").fill("архив");
  await inline.getByLabel("Ссылка в источнике").fill("л. 5");
  await panel.getByRole("button", { name: "Сохранить союз" }).click();
  expect(readFamily().unions!.find((union) => union.id === id)!.sources?.[0].title)
    .toBe("Запись о партнёрстве");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
