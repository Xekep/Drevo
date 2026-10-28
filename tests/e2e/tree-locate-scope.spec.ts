import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_TREE_PREFERENCES, type TreePreferences } from "../../src/domain/tree-preferences";
import { pagedPhotoFixture } from "./paged-photo-fixture";

async function limitedTree(page: Page, assistantFilterIds?: string[], presentation: "flat" | "depth" = "flat") {
  let preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
    presentation,
    generationLimits: { anchorId: "e2e-child", ancestors: 3, descendants: 1, collateral: 0 },
  };
  const writes: TreePreferences[] = [];
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = null;
    await route.fulfill({ response, json: { ...data, treePreferences: preferences } });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    if (route.request().method() === "PUT") {
      preferences = route.request().postDataJSON();
      writes.push(preferences);
    }
    await route.fulfill({ json: preferences });
  });
  if (assistantFilterIds) {
    await page.route("**/api/ai/status", (route) =>
      route.fulfill({ json: { enabled: true, streaming: true } }),
    );
    await page.route("**/api/ai/chats", (route) =>
      route.fulfill({ json: { chats: [] } }),
    );
    await page.route("**/api/ai/chat/stream", (route) =>
      route.fulfill({
        contentType: "text/event-stream; charset=utf-8",
        body: `event: done\ndata: ${JSON.stringify({ answer: "Фильтр применён.", references: [], suggestionIds: [], uiActions: [{ type: "filter_people", personIds: assistantFilterIds, label: "Выборка" }], files: [] })}\n\n`,
      }),
    );
  }
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-layout-people", "4");
  return { writes, original: structuredClone(preferences) };
}

for (const presentation of ["flat", "depth"] as const) {
  for (const source of ["photo", "place"] as const) {
    test(`navigation from ${source} reveals a hidden person by changing the ${presentation} anchor`, async ({ page, isMobile }) => {
      const { writes, original } = await limitedTree(page, undefined, presentation);
      if (source === "photo") {
        const photo = {
          id: "anchor-navigation-photo", title: "Снимок Марии", url: "/media/anchor-navigation.png",
          tags: [{ id: "maria", personId: "e2e-sibling", x: 0.1, y: 0.1, width: 0.2, height: 0.3 }],
        };
        await pagedPhotoFixture(page, [photo]);
        await page.route("**/media/anchor-navigation.png**", route => route.fulfill({
          contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"/>',
        }));
        await page.goto(`/photos/${photo.id}`);
        if (isMobile) {
          await page.getByRole("button", { name: "О снимке", exact: true }).click();
          await page.locator(".photo-people-names .photo-person-name").click();
        }
        else await page.getByRole("button", { name: /Показать сведения:.*Мария/ }).click();
        await expect(page.locator(".photo-person-sidebar")).toBeVisible();
        // Viewing information alone does not change the generation window.
        expect(writes).toEqual([]);
        await page.getByRole("button", { name: "Показать в древе" }).click();
      } else {
        await page.route("**/api/places/locate**", route => route.fulfill({ json: { candidates: [] } }));
        await page.route("https://tile.openstreetmap.org/**", route => route.abort());
        await page.goto("/places");
        if (isMobile) await page.locator(".map-list-toggle").click();
        await page.locator(".places-list").getByRole("button", { name: /Москва/ }).click();
        await page.locator(".place-events").getByRole("button", { name: /Тестова Мария Ивановна/ }).click();
      }
      await expect(page).toHaveURL(/\/people\/e2e-sibling$/);
      await expect.poll(() => writes.length).toBe(1);
      expect(writes[0]).toEqual({
        ...original,
        generationLimits: { ...original.generationLimits!, anchorId: "e2e-sibling" },
      });
      const canvas = page.locator(".tree-canvas");
      await expect(canvas.getByRole("status", { name: "Опорный человек" })).toContainText("Мария");
      await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
      if (presentation === "depth") {
        await expect(canvas).toHaveAttribute("data-depth-anchor", "e2e-sibling");
        await expect(page.locator(".tree-spatial")).toHaveAttribute("aria-busy", "false");
      } else {
        await expect(page.locator('.flow-person[data-person-id="e2e-sibling"]')).toBeVisible();
        if (!isMobile) await expectCentered(page, "e2e-sibling");
      }
      if (source === "place") {
        await page.goto("/places");
        if (isMobile) await page.locator(".map-list-toggle").click();
        await page.locator(".places-list").getByRole("button", { name: /Москва/ }).click();
        await page.locator(".place-events").getByRole("button", { name: /Тестова Ольга/ }).click();
        await expect(page).toHaveURL(/\/people\/e2e-sibling-child$/);
        await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
        await expect(canvas.getByRole("status", { name: "Опорный человек" })).toContainText("Мария");
        expect(writes).toHaveLength(1);
      }
    });
  }
}

async function searchPerson(page: Page, query: string, name: RegExp) {
  await page.getByRole("combobox", { name: /Найти человека/ }).fill(query);
  await page.getByRole("option", { name }).click();
  await expect(page.locator(".inspector-dock")).toContainText(query);
}

async function expectCentered(page: Page, personId: string) {
  await expect.poll(async () => {
    const stage = await page.locator(".react-flow").boundingBox();
    const card = await page.locator(
      `.react-flow__node:has(.flow-person[data-person-id="${personId}"])`,
    ).first().boundingBox();
    if (!stage || !card) return Infinity;
    return Math.max(
      Math.abs(card.x + card.width / 2 - stage.x - stage.width / 2),
      Math.abs(card.y + card.height / 2 - stage.y - stage.height / 2),
    );
  }).toBeLessThan(12);
}

test("locating a searched person outside the generation window changes only its anchor", async ({ page, isMobile }) => {
  test.skip(isMobile, "The desktop camera toolbar owns this action");
  const { writes, original } = await limitedTree(page);
  const hidden = page.locator('.flow-person[data-person-id="e2e-sibling"]');
  await expect(hidden).toHaveCount(0);
  await searchPerson(page, "Мария", /Тестова Мария/);
  // Opening a search result must retain the user's current generation window.
  await expect(page).toHaveURL(/\/people\/e2e-sibling$/);
  await expect(hidden).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-layout-people", "4");
  expect(writes).toEqual([]);

  await page.getByRole("button", { name: "К выбранному человеку", exact: true }).click();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0]).toEqual({
    ...original,
    generationLimits: { ...original.generationLimits!, anchorId: "e2e-sibling" },
  });
  await expect(hidden).toBeVisible();
  await expect(page.locator('.flow-person[data-person-id="e2e-sibling-child"]')).toBeVisible();
  await expect(page.locator('.flow-person[data-person-id="e2e-grandchild"]')).toHaveCount(0);
  await expectCentered(page, "e2e-sibling");
  await expect(page.locator(".react-flow__viewport")).toHaveCSS("transform", /matrix\(0\.55,/);
});

test("locating an already visible person moves the camera without saving generation limits", async ({ page, isMobile }) => {
  test.skip(isMobile, "The desktop camera toolbar owns this action");
  const { writes } = await limitedTree(page);
  await searchPerson(page, "Иван", /Тестов Иван Петрович/);
  await expectCentered(page, "e2e-memorial-person");
  const viewport = page.locator(".react-flow__viewport");
  const stage = (await page.locator(".react-flow").boundingBox())!;
  const before = await viewport.getAttribute("style");
  await page.mouse.move(stage.x + stage.width - 35, stage.y + stage.height - 100);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(stage.x + stage.width - 175, stage.y + stage.height - 180, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  await expect(viewport).not.toHaveAttribute("style", before!);
  await page.getByRole("button", { name: "К выбранному человеку", exact: true }).click();
  await expectCentered(page, "e2e-memorial-person");
  expect(writes).toEqual([]);
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-layout-people", "4");
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(dialog.getByRole("combobox", { name: "Относительно человека" }))
    .toHaveValue("Тестов Пётр Иванович");
  await expect(dialog.getByRole("radio", { name: "Предки: 3", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Потомки: 1", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Боковые ветви: 0", exact: true })).toBeChecked();
});

test("locating a person excluded by the research filter leaves the camera and anchor unchanged", async ({ page, isMobile }) => {
  test.skip(isMobile, "The desktop camera toolbar owns this action");
  const { writes } = await limitedTree(page, ["e2e-child"]);
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const assistant = page.locator(".research-assistant");
  await assistant.getByRole("textbox").fill("Оставь только одного человека");
  await assistant.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.getByRole("group", { name: "Сводка выборки древа" })).toContainText("Выборка: 1 из");
  await assistant.getByRole("button", { name: "Закрыть ИИ-исследователя" }).click();
  await searchPerson(page, "Мария", /Тестова Мария/);
  await expect(page.locator('.flow-person[data-person-id="e2e-sibling"]')).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-layout-settling/);
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");

  await page.getByRole("button", { name: "К выбранному человеку", exact: true }).click();
  await expect(page.locator(".tree-notice")).toContainText(
    "Человек скрыт фильтром исследования. Снимите фильтр, чтобы перейти к нему",
  );
  await expect(viewport).toHaveAttribute("style", before!);
  expect(writes).toEqual([]);
  await expect(page.locator('.flow-person[data-person-id="e2e-sibling"]')).toHaveCount(0);
});
