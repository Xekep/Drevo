import { expect, test } from "@playwright/test";
import { e2eFamily } from "./base-family";
import { familyViewAction } from "./tree-toolbar-actions";

for (const mode of ["Кровные", "Близкие"]) test(`closing a searched person retains the ${mode} anchor and camera`, async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), data = await response.json();
    data.family = e2eFamily(data.family);
    data.partial = false;
    data.treePreferences = { ...data.treePreferences, animateOnLoad: false, fragmentThreshold: 0, generationLimits: undefined };
    await route.fulfill({ response, json: data });
  });
  await page.goto("/people/e2e-child");
  const tree = page.locator(".tree-canvas");
  await expect(tree).toHaveAttribute("data-camera-ready", "true");
  const collapse = page.getByRole("button", { name: "Свернуть панель", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await familyViewAction(page, mode);
  const search = page.getByRole("combobox", { name: "Найти человека или документ" });
  await search.fill("Елена");
  await page.getByRole("listbox", { name: "Найденные люди и документы" })
    .getByRole("option", { name: /Елена/ }).click();
  await expect(page).toHaveURL(/\/people\/e2e-spouse$/);
  await expect(tree).toHaveAttribute("data-layout-ready", "true");
  const person = tree.locator('.flow-person[data-person-id="e2e-spouse"]');
  await expect(person).toBeVisible();
  await expect.poll(() => tree.locator(".react-flow__viewport").evaluate(e =>
    new DOMMatrix(getComputedStyle(e).transform).a)).toBeCloseTo(.55, 3);
  const people = await tree.getAttribute("data-layout-people");
  const before = await tree.locator(".react-flow__viewport").evaluate(e => getComputedStyle(e).transform);
  await page.getByRole("button", { name: "Закрыть панель", exact: true }).click();
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
  await page.waitForTimeout(700);
  await expect(tree).toHaveAttribute("data-layout-people", people!);
  expect(await tree.locator(".react-flow__viewport").evaluate(e => getComputedStyle(e).transform)).toBe(before);
});
