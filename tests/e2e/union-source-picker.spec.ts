import { expect, test } from "@playwright/test";

test("источник каталога подтверждает союз и его этапы", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const title = `Запись о браке ${info.project.name}`;
  const created = await page.request.post("/api/sources", { data: { title, archive: "ГАСО", fond: "6" } });
  expect(created.status()).toBe(201);
  const sourceId = (await created.json()).source.id;

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
  await formation.getByText("Источники этапа (0)").click();
  await choose(formation);
  const divorce = panel.getByRole("group", { name: "Развод" });
  await divorce.getByText("Источники этапа (0)").click();
  await choose(divorce);
  await panel.getByRole("button", { name: "Сохранить союз" }).click();

  const family = await page.request.get("/api/family").then((response) => response.json());
  const union = family.family.unions.find((item: { participants: string[]; sources?: { catalogId?: string }[] }) =>
    item.participants.includes("e2e-child") && item.participants.includes("e2e-spouse") &&
    item.sources?.some((source: { catalogId?: string }) => source.catalogId === sourceId));
  expect(union.sources[0].catalogId).toBe(sourceId);
  expect(union.sources[1].title).toBe("Семейное предание");
  expect(union.formation.sources[0].catalogId).toBe(sourceId);
  expect(union.divorce.sources[0].catalogId).toBe(sourceId);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
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
  const citation = { catalogId: source.id, title: source.title, type: "", reference: "" };
  const firstId = crypto.randomUUID(), secondId = crypto.randomUUID();
  const snapshot = await page.request.get("/api/family").then((response) => response.json());
  const saved = await page.request.put("/api/family", {
    headers: { "If-Match": String(snapshot.revision), Origin: "http://127.0.0.1:4173" },
    data: { ...snapshot.family, unions: [ ...(snapshot.family.unions || []),
      { id: firstId, participants: ["e2e-child", "e2e-spouse"], type: "marriage",
        divorce: { date: "1930", sources: [citation] } },
      { id: secondId, participants: ["e2e-child", "e2e-spouse"], type: "marriage",
        ending: { date: "1980", sources: [citation] } },
    ] },
  });
  expect(saved.status()).toBe(200);
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
  let family = await page.request.get("/api/family").then((response) => response.json());
  expect(family.family.unions.find((union: { id: string }) => union.id === firstId).divorce.sources[0].catalogId).toBe(source.id);

  panel = await openPanel();
  await panel.locator(".event-card").filter({ hasText: "1980" }).getByRole("button", { name: "Изменить союз" }).click();
  await expect(panel.getByRole("group", { name: "Развод" })).toContainText("Источники можно добавить после выбора этого этапа");
  await expect(panel.getByRole("group", { name: "Развод" }).getByRole("button", { name: "Выбрать из каталога" })).toHaveCount(0);
  await panel.getByLabel("Примечание").fill("Проверка окончания");
  await panel.getByRole("button", { name: "Сохранить союз" }).click();
  family = await page.request.get("/api/family").then((response) => response.json());
  expect(family.family.unions.find((union: { id: string }) => union.id === secondId).ending.sources[0].catalogId).toBe(source.id);
});
