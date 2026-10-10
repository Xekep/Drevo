import { test, expect } from "@playwright/test";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences";

test("reference autocomplete keeps the saved anchor while typing and finds people outside the visible scope", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
    generationLimits: {
      anchorId: "e2e-child",
      ancestors: 3,
      descendants: 1,
      collateral: 0,
    },
  };
  const writes: TreePreferences[] = [];
  let rejectSave = false;
  const searchRequests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/people/search"))
      searchRequests.push(request.url());
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({
      response,
      json: { ...data, treePreferences: preferences },
    });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    if (route.request().method() === "PUT") {
      if (rejectSave) {
        await route.fulfill({
          status: 503,
          json: { error: "Сохранение временно недоступно" },
        });
        return;
      }
      preferences = route.request().postDataJSON();
      writes.push(preferences);
    }
    await route.fulfill({ json: preferences });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-people", "4");
  const anchorStatus = page.getByRole("status", { name: "Опорный человек" });
  await expect(anchorStatus).toContainText("Опорный: Тестов Пётр Иванович");
  await expect(anchorStatus.locator(".tree-family-count")).toHaveText("4 из 6");
  await expect(anchorStatus.locator(".tree-family-count")).toBeVisible();
  if (testInfo.project.name === "mobile") {
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      const bounds = (await anchorStatus.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
      expect(
        await anchorStatus.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThanOrEqual(1);
      await expect(anchorStatus.locator(".tree-family-count")).toBeVisible();
    }
  }
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  const input = dialog.getByRole("combobox", { name: "Относительно человека" });
  await expect(input).toHaveValue("Тестов Пётр Иванович");
  await input.fill("Такого человека нет");
  await expect(
    dialog.getByText("Никого не найдено. Попробуйте другую часть ФИО."),
  ).toBeVisible();
  await input.press("Enter");
  await expect(canvas).toHaveAttribute("data-layout-people", "4");
  expect(writes).toEqual([]);
  await input.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(input).toHaveValue("Тестов Пётр Иванович");
  await input.fill("");
  await input.press("Tab");
  await expect(input).toHaveValue("Тестов Пётр Иванович");
  expect(writes).toEqual([]);
  await input.fill("мария");
  const option = dialog.getByRole("option", {
    name: /Тестова Мария Ивановна.*1968/,
  });
  await expect(option).toBeVisible();
  await expect(
    page.locator('.flow-person[data-person-id="e2e-sibling"]'),
  ).toHaveCount(0);
  await dialog.screenshot({
    path: testInfo.outputPath("reference-search.png"),
  });
  await input.press("ArrowDown");
  await expect(option).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(input).toHaveValue("Тестова Мария Ивановна");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).toBeFocused();
  await expect.poll(() => writes.length).toBe(1);
  expect(writes[0].generationLimits).toEqual({
    anchorId: "e2e-sibling",
    ancestors: 3,
    descendants: 1,
    collateral: 0,
  });
  rejectSave = true;
  await input.fill("Елена");
  await dialog.getByRole("option", { name: /Тестова Елена Сергеевна/ }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    "Сохранение временно недоступно",
  );
  await expect(input).toHaveValue("Тестова Мария Ивановна");
  expect(writes).toHaveLength(1);
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(
    page.locator('.flow-person[data-person-id="e2e-sibling"]'),
  ).toBeVisible();
  await expect(anchorStatus).toContainText("Опорный: Тестова Мария Ивановна");
  await expect(anchorStatus.locator(".tree-family-count")).toHaveText("3 из 6");
  await expect(canvas).toHaveAttribute("data-layout-people", "3");
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  await page.screenshot({ path: testInfo.outputPath("anchor-status.png") });
  expect(searchRequests).toEqual([]);
  rejectSave = false;
  await anchorStatus.getByRole("button", { name: "Снять ограничения поколений", exact: true }).click();
  await expect(anchorStatus).toHaveCount(0);
  await expect(canvas).toHaveAttribute("data-layout-people", "6");
  await expect.poll(() => writes.length).toBe(2);
  expect(writes[1].generationLimits).toBeNull();
});

test("generation settings trim the visible tree and survive reload without changing genealogy", async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let preferences: TreePreferences = { ...DEFAULT_TREE_PREFERENCES };
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.treePreferences = preferences;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    if (route.request().method() === "PUT") {
      preferences = route.request().postDataJSON();
      if (!preferences.generationLimits) delete preferences.generationLimits;
    }
    await route.fulfill({ json: preferences });
  });
  const card = (id: string) =>
    page.locator(`.flow-person[data-person-id="${id}"]`).first();
  await page.goto("/tree");
  const anchorStatus = page.getByRole("status", { name: "Опорный человек" });
  await expect(anchorStatus).toHaveCount(0);
  await expect(card("e2e-sibling-child")).toBeVisible();
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(
    dialog.getByRole("switch", { name: "Ограничить видимое древо" }),
  ).not.toBeChecked();
  await dialog
    .getByRole("switch", { name: "Ограничить видимое древо" })
    .check();
  await dialog
    .getByRole("combobox", { name: "Относительно человека" })
    .fill("Пётр");
  await dialog.getByRole("option", { name: /Тестов Пётр Иванович/ }).click();
  await dialog.getByRole("radio", { name: "Потомки: 1", exact: true }).check();
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 0", exact: true })
    .check();
  await expect(
    dialog.getByText("В области поколений: 4 из 6 карточек"),
  ).toBeVisible();
  await expect(card("e2e-sibling")).toHaveCount(0);
  await expect(card("e2e-sibling-child")).toHaveCount(0);
  await expect(card("e2e-spouse")).toBeVisible();
  await expect(card("e2e-grandchild")).toBeVisible();
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await dialog.screenshot({
    path: testInfo.outputPath("generation-settings.png"),
  });
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await page.reload();
  await expect(card("e2e-child")).toBeVisible();
  await expect(card("e2e-sibling")).toHaveCount(0);
  await expect(anchorStatus).toContainText("Опорный: Тестов Пётр Иванович");
  await expect(anchorStatus.locator(".tree-family-count")).toHaveText("4 из 6");
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Относительно человека" }),
  ).toHaveValue("Тестов Пётр Иванович");
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 1", exact: true })
    .check();
  await expect(card("e2e-sibling")).toBeVisible();
  await expect(card("e2e-sibling-child")).toHaveCount(0);
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 2", exact: true })
    .check();
  await expect(card("e2e-sibling-child")).toBeVisible();
  await dialog.getByRole("radio", { name: "Предки: 7+", exact: true }).check();
  await dialog.getByRole("radio", { name: "Потомки: 50", exact: true }).check();
  await dialog
    .getByRole("switch", { name: "Ограничить видимое древо" })
    .uncheck();
  await expect(anchorStatus).toHaveCount(0);
  await expect(card("e2e-sibling-child")).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Относительно человека" }),
  ).toHaveCount(0);
  const family = await (await page.request.get("/api/family")).json();
  expect(family.family.people).toHaveLength(6);
  expect(
    family.family.people.find(
      (person: { id: string }) => person.id === "e2e-grandchild",
    ).parents,
  ).toEqual(["e2e-child"]);
});

test("a 1023-person archive sends only the bounded projection to the layout Worker", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const counts: number[] = [];
    Object.assign(window, { layoutPeopleCounts: counts });
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(target, thisArg, args) {
        if (Array.isArray(args[0]?.people)) counts.push(args[0].people.length);
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.partial = false;
    data.family.links = [];
    data.family.people = Array.from({ length: 1023 }, (_, i) => ({
      id: String(i),
      name: `Человек ${i}`,
      surname: "Тестов",
      patronymic: "",
      birth: "",
      birthPlace: "",
      sex: "u",
      parents: i ? [String(Math.floor((i - 1) / 2))] : [],
      spouses: [],
      sources: [],
      column: 0,
      generation: 1,
    }));
    data.treePreferences = {
      ...DEFAULT_TREE_PREFERENCES,
      generationLimits: {
        anchorId: "31",
        ancestors: 3,
        descendants: 1,
        collateral: 0,
      },
    };
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    await route.fulfill({ json: route.request().postDataJSON() });
  });
  await page.goto("/tree");
  await expect(page.locator('.flow-person[data-person-id="31"]')).toBeVisible();
  await expect(page.locator(".flow-person")).toHaveCount(6);
  const counts = await page.evaluate(
    () =>
      (window as Window & { layoutPeopleCounts?: number[] })
        .layoutPeopleCounts || [],
  );
  expect(counts.length).toBeGreaterThan(0);
  expect(counts.every((count) => count === 6)).toBe(true);
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await expect(
    page.getByText("В области поколений: 6 из 1023 карточек"),
  ).toBeVisible();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog
    .getByRole("combobox", { name: "Относительно человека" })
    .fill("Человек 1000");
  await dialog.getByRole("option", { name: /^Тестов Человек 1000/ }).click();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(
    page.locator('.flow-person[data-person-id="1000"]'),
  ).toBeVisible();
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-people",
    "4",
  );
});

test("generation settings remain usable while the initial layout is still computing", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Worker.prototype.postMessage = new Proxy(Worker.prototype.postMessage, {
      apply(target, thisArg, args) {
        // Deliberately keep the initial six-person request pending. A smaller
        // projection must cancel it and run in a fresh Worker.
        if (args[0]?.people?.length === 6) return;
        return Reflect.apply(target, thisArg, args);
      },
    });
  });
  let preferences: TreePreferences = { ...DEFAULT_TREE_PREFERENCES };
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.treePreferences = preferences;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    preferences = route.request().postDataJSON();
    await route.fulfill({ json: preferences });
  });
  await page.goto("/tree");
  const gear = page.getByRole("button", { name: "Настройки древа" });
  await expect(gear).toBeEnabled();
  await expect(
    page
      .getByRole("button", { name: "Хронология", exact: true })
      .or(page.getByRole("switch", { name: "Древо / Хронология" })),
  ).toBeDisabled();
  await gear.click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByRole("switch", { name: "Ограничить видимое древо" })
    .check();
  await dialog
    .getByRole("combobox", { name: "Относительно человека" })
    .fill("Пётр");
  await dialog.getByRole("option", { name: /Тестов Пётр Иванович/ }).click();
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 0", exact: true })
    .check();
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await expect(
    page.locator('.flow-person[data-person-id="e2e-child"]'),
  ).toBeVisible({ timeout: 15000 });
  await expect(page.locator(".flow-person")).toHaveCount(4);
});
