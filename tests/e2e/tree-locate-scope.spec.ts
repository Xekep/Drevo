import { expect, test, type Page } from "@playwright/test";
import { DEFAULT_TREE_PREFERENCES, type TreePreferences } from "../../src/domain/tree-preferences";

async function limitedTree(page: Page) {
  let preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
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
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await expect(page.locator(".tree-canvas")).toHaveAttribute("data-layout-people", "4");
  return { writes, original: structuredClone(preferences) };
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
  const { writes, original } = await limitedTree(page);
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
    .toHaveValue(original.generationLimits!.anchorId);
  await expect(dialog.getByRole("radio", { name: "Вверх: 3", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Вниз: 1", exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Боковые ветви: 0", exact: true })).toBeChecked();
});
