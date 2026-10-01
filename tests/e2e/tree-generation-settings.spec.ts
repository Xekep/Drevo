import { test, expect } from "@playwright/test";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences";

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
  await expect(card("e2e-sibling-child")).toBeVisible();
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(
    dialog.getByRole("checkbox", { name: "Ограничить видимое древо" }),
  ).not.toBeChecked();
  await dialog
    .getByRole("checkbox", { name: "Ограничить видимое древо" })
    .check();
  await dialog
    .getByRole("combobox", { name: "Относительно человека" })
    .selectOption("e2e-child");
  await dialog.getByRole("radio", { name: "Вниз: 1", exact: true }).check();
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
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Относительно человека" }),
  ).toHaveValue("e2e-child");
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 1", exact: true })
    .check();
  await expect(card("e2e-sibling")).toBeVisible();
  await expect(card("e2e-sibling-child")).toHaveCount(0);
  await dialog
    .getByRole("radio", { name: "Боковые ветви: 2", exact: true })
    .check();
  await expect(card("e2e-sibling-child")).toBeVisible();
  await dialog.getByRole("radio", { name: "Вверх: 7+", exact: true }).check();
  await dialog.getByRole("radio", { name: "Вниз: 50", exact: true }).check();
  await dialog
    .getByRole("checkbox", { name: "Ограничить видимое древо" })
    .uncheck();
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
});
