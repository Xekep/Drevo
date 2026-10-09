import { expect, test } from "@playwright/test";

test("Shift selects people without selecting controls, while inputs and profile text remain selectable", async ({ page, isMobile }) => {
  test.skip(isMobile, "Mouse and desktop keyboard interaction");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  const headerButtons = page.locator(".archive-header button");
  expect(await headerButtons.count()).toBeGreaterThan(0);
  expect(await headerButtons.evaluateAll((elements) => elements.every(
    (el) => getComputedStyle(el).userSelect === "none",
  ))).toBe(true);
  const mode = page.getByRole("button", { name: "Древо", exact: true });
  const box = (await mode.boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 8, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 8, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  expect(await mode.evaluate((el) => getComputedStyle(el).userSelect)).toBe("none");
  const child = page.locator('.flow-person[data-person-id="e2e-child"] .flow-person-content').first();
  await child.click({ modifiers: ["Shift"] });
  const sibling = page.locator('.flow-person[data-person-id="e2e-sibling"] .flow-person-content').first();
  await sibling.click({ modifiers: ["Shift"] });
  await expect(page.locator(".flow-person.is-selected")).toHaveCount(2);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  const input = page.locator(".archive-search input");
  await input.fill("Тестов");
  await input.press("End");
  await input.press("Shift+ArrowLeft");
  await input.press("Shift+ArrowLeft");
  expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe("ов");
  await input.fill("");
  await input.press("Escape");
  await child.click();
  const text = page.locator(".inspector-dock h2").first();
  await expect(text).toBeVisible();
  expect(await text.evaluate((el) => getComputedStyle(el).userSelect)).not.toBe("none");
  const heading = (await text.boundingBox())!;
  await page.mouse.move(heading.x + 2, heading.y + heading.height / 2);
  await page.mouse.down();
  await page.mouse.move(heading.x + heading.width - 2, heading.y + heading.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString().length)).toBeGreaterThan(0);
});
