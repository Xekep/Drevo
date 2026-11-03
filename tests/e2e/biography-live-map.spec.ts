import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";
import {
  biographyMapBlock,
  type BiographyMap,
} from "../../src/domain/biography-map.ts";

const routeMap: BiographyMap = {
  type: "FeatureCollection",
  name: "Боевой путь",
  features: [
    {
      type: "Feature",
      properties: { name: "Первый пункт", date: "1942" },
      geometry: { type: "Point", coordinates: [30, 50] },
    },
    {
      type: "Feature",
      properties: { name: "Второй пункт", date: "1943" },
      geometry: { type: "Point", coordinates: [32, 52] },
    },
    {
      type: "Feature",
      properties: { name: "Маршрут" },
      geometry: {
        type: "LineString",
        coordinates: [
          [30, 50],
          [32, 52],
        ],
      },
    },
  ],
};
async function setup(page: Page, biography: string) {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  const response = await page.request.get("/api/family?projection=overview"),
    initial = await response.json();
  let family = (await (await page.request.get("/api/family")).json())
      .family as Family,
    revision = initial.revision;
  family.people.find((p) => p.id === "e2e-child")!.biography = biography;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({
      response,
      json: { ...initial, family, revision, partial: false },
    }),
  );
  await page.route("**/api/family/changes", (route) => {
    const changes = route.request().postDataJSON().changes as Change[],
      applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    return route.fulfill({
      json: { family, revision, appliedChanges: changes },
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  return () => family.people.find((p) => p.id === "e2e-child")!.biography || "";
}
async function edit(page: Page) {
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("Жизнь и занятия", { exact: true }).click();
  await expect(page.locator(".biography-editor .cm-content")).toBeVisible();
  return page.locator(".biography-editor");
}

test("biography exposes Markdown only on the active line and preserves source on save", async ({
  page,
}) => {
  const source =
    "# Заголовок\nПервая **жирная** строка\nВторая *курсивная* строка\n\n- Пункт";
  const read = await setup(page, source),
    editor = await edit(page);
  const first = editor.locator(".cm-line").filter({ hasText: "Первая" }),
    second = editor.locator(".cm-line").filter({ hasText: "Вторая" });
  await expect(first).toHaveText("Первая жирная строка");
  await first.click();
  await expect(first).toHaveText("Первая **жирная** строка");
  await second.click();
  await expect(first).toHaveText("Первая жирная строка");
  await expect(second).toHaveText("Вторая *курсивная* строка");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe(source);
});

test("a map replaces the tree, lists dated points and restores the same camera", async ({
  page,
}) => {
  await setup(page, "История пути\n\n" + biographyMapBlock(routeMap));
  const mini = page.locator(".inspector-dock .biography-map-mini");
  await expect(mini).toBeVisible();
  const transform = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await mini.click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  await expect(workspace).toBeVisible();
  await expect(page.locator(".tree-view")).toHaveAttribute("inert", "");
  await workspace.getByText("Точки маршрута", { exact: true }).click();
  await expect(workspace).toContainText("Первый пункт");
  await expect(workspace).toContainText("1943");
  await expect(workspace.locator(".leaflet-interactive")).toHaveCount(3);
  await page.screenshot({ path: test.info().outputPath("map-workspace.png") });
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveCount(0);
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    transform!,
  );
  await expect(mini).toBeVisible();
});

test("the visual map editor adds, reorders and saves a route inside the biography", async ({
  page,
}) => {
  const read = await setup(page, "Воспоминания"),
    editor = await edit(page);
  await editor.getByRole("button", { name: "Добавить карту" }).click();
  const dialog = page.getByRole("dialog", { name: "Карта жизни", exact: true });
  await dialog.getByLabel("Название карты").fill("Путь домой");
  await dialog.getByLabel("Соединить точки по порядку").check();
  for (const [lat, lon] of [
    [50, 30],
    [52, 32],
  ]) {
    await dialog.getByLabel("Широта", { exact: true }).fill(String(lat));
    await dialog.getByLabel("Долгота", { exact: true }).fill(String(lon));
    await dialog
      .getByRole("button", { name: "Добавить точку", exact: true })
      .click();
  }
  await dialog.getByLabel("Название точки 1").fill("Начало");
  await dialog.getByLabel("Дата точки 1").fill("1943");
  await dialog.locator(".biography-map-surface").scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("map-editor.png") });
  await dialog
    .getByRole("button", { name: "Поднять точку 2", exact: true })
    .click();
  await dialog.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(editor.locator(".biography-map-mini")).toBeVisible();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  const saved = JSON.parse(
    read().split("```geojson\n")[1].split("\n```")[0],
  ) as BiographyMap;
  expect(saved.name).toBe("Путь домой");
  expect(saved.features[1].properties).toMatchObject({
    name: "Начало",
    date: "1943",
  });
  expect(saved.features.at(-1)!.geometry).toEqual({
    type: "LineString",
    coordinates: [
      [32, 52],
      [30, 50],
    ],
  });
  expect(read().startsWith("Воспоминания\n\n")).toBe(true);
});

test("editing a repeated map changes the selected block and malformed imports retain the draft", async ({
  page,
}) => {
  const block = biographyMapBlock(routeMap),
    read = await setup(page, block + "\n\nМежду картами\n\n" + block);
  const editor = await edit(page);
  await editor
    .getByRole("button", { name: "Изменить карту", exact: true })
    .nth(1)
    .click();
  const dialog = page.getByRole("dialog", { name: "Карта жизни", exact: true });
  await dialog.getByLabel("Файл GeoJSON").setInputFiles({
    name: "broken.geojson",
    mimeType: "application/geo+json",
    buffer: Buffer.from('{"type":"Point","coordinates":[0,91]}'),
  });
  await expect(dialog.getByRole("alert")).toContainText("Координаты");
  await dialog.getByLabel("Название карты").fill("Вторая карта");
  await dialog.getByRole("button", { name: "Готово", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read().startsWith(block + "\n\nМежду картами")).toBe(true);
  expect(read().match(/Вторая карта/g)).toHaveLength(1);
});

test("map clicks create points, cancelling retains biography and imported metadata survives", async ({
  page,
}) => {
  const read = await setup(page, "Исходная история"),
    editor = await edit(page);
  await editor.getByRole("button", { name: "Добавить карту" }).click();
  const dialog = page.getByRole("dialog", { name: "Карта жизни", exact: true });
  await expect(dialog.locator(".leaflet-container")).toBeVisible();
  await dialog
    .locator(".biography-map-surface")
    .click({ position: { x: 100, y: 120 } });
  await expect(dialog.getByLabel("Название точки 1")).toHaveValue("Точка 1");
  page.once("dialog", (d) => d.accept());
  await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(editor.locator(".biography-map-mini")).toHaveCount(0);
  expect(read()).toBe("Исходная история");
  await editor.getByRole("button", { name: "Добавить карту" }).click();
  const imported = structuredClone(routeMap);
  imported.features[0].id = "imported-1";
  imported.features[0].properties = {
    name: "<img src=x onerror=alert(1)>",
    unit: "Полк",
    source: { page: 5 },
  };
  await dialog.getByLabel("Файл GeoJSON").setInputFiles({
    name: "route.geojson",
    mimeType: "application/geo+json",
    buffer: Buffer.from(JSON.stringify(imported)),
  });
  await expect(dialog.getByLabel("Название точки 1")).toHaveValue(
    "<img src=x onerror=alert(1)>",
  );
  await dialog.getByLabel("Название карты").fill("Импортированный путь");
  await dialog.getByRole("button", { name: "Готово", exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  const saved = JSON.parse(
    read().split("```geojson\n")[1].split("\n```")[0],
  ) as BiographyMap;
  expect(saved.features).toEqual(imported.features);
  await page.locator(".inspector-dock .biography-map-mini").click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  await workspace.getByText("Точки маршрута", { exact: true }).click();
  await expect(workspace).toContainText("<img src=x onerror=alert(1)>");
  await expect(workspace.locator("img[onerror]")).toHaveCount(0);
});

test("malformed map blocks can be reopened as Markdown source", async ({
  page,
}) => {
  const source = "```geojson\n{broken}\n```";
  const read = await setup(page, source),
    editor = await edit(page);
  await editor.getByRole("button", { name: "Исправить код карты" }).click();
  await expect(editor.locator(".cm-content")).toContainText("{broken}");
  await expect(
    editor.getByRole("button", { name: "Исправить код карты" }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe(source);
});

test("the expanded life editor cancels its nested map draft and applies Markdown explicitly", async ({
  page,
}) => {
  const source = "Исходная **биография**",
    read = await setup(page, source);
  await edit(page);
  const expand = page.getByRole("button", {
    name: "Открыть жизнь и занятия в отдельном окне",
  });
  await expand.click();
  const life = page.getByRole("dialog", {
    name: "Жизнь и занятия",
    exact: true,
  });
  await life.getByRole("button", { name: "Добавить карту" }).click();
  const map = page.getByRole("dialog", { name: "Карта жизни", exact: true });
  await map.getByLabel("Название карты").fill("Несохранённая карта");
  await map.getByRole("button", { name: "Готово", exact: true }).click();
  await expect(life.locator(".biography-map-mini")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await life.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(life).toHaveCount(0);
  await expect(
    page.locator(".biography-editor .biography-map-mini"),
  ).toHaveCount(0);
  await expand.click();
  const text = life.locator(".cm-content");
  await text.click();
  await text.press("Control+End");
  await text.press("End");
  await text.pressSequentially(" дополнено");
  await life.getByRole("button", { name: "Готово", exact: true }).click();
  expect(read()).toBe(source);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe(source + " дополнено");
});
