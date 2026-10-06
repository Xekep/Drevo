import { expect, test } from "@playwright/test";

test("branch controls keep readable targets when the tree is zoomed out", async ({ page }) => {
  await page.goto("/tree");
  const smaller = page.getByRole("button", { name: "Уменьшить", exact: true });
  await expect(smaller).toBeEnabled();
  for (let step = 0; step < 3; step++) {
    const controls = page.locator(".flow-collapse");
    await expect(controls.first()).toBeVisible();
    const sizes = await controls.evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    }));
    for (const size of sizes) {
      expect(size.width).toBeGreaterThanOrEqual(24);
      expect(size.height).toBeGreaterThanOrEqual(24);
    }
    if (step < 2) { await smaller.click(); await page.waitForTimeout(350); }
  }
});
