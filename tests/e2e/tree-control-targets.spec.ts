import { expect, test } from "@playwright/test";

test("branch controls keep readable targets when the tree is zoomed out", async ({
  page,
}, testInfo) => {
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-ready",
    "true",
  );
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  const smaller = page.getByRole("button", { name: "Уменьшить", exact: true });
  const steps = testInfo.project.name === "mobile" ? 1 : 3;
  if (steps > 1) await expect(smaller).toBeEnabled();
  for (let step = 0; step < steps; step++) {
    const controls = page.locator(".flow-collapse");
    await expect(controls.first()).toBeVisible();
    const sizes = await controls.evaluateAll((elements) =>
      elements.map((element) => {
        const rect = element.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      }),
    );
    for (const size of sizes) {
      expect(size.width).toBeGreaterThanOrEqual(24);
      expect(size.height).toBeGreaterThanOrEqual(24);
    }
    const card = page
      .getByTestId("rf__node-e2e-child")
      .locator(".flow-person-content");
    await expect
      .poll(() =>
        card.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          return element.contains(
            document.elementFromPoint(
              rect.x + rect.width / 2,
              rect.y + rect.height / 2,
            ),
          );
        }),
      )
      .toBe(true);
    if (step < steps - 1) {
      await smaller.click();
      await page.waitForTimeout(350);
    }
  }
});
