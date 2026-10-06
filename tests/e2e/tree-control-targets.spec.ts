import { expect, test } from "@playwright/test";

test("branch pills follow portrait scale with a usable transparent target", async ({
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
        const target = getComputedStyle(element, "::before");
        const viewport = element.closest(".react-flow__viewport")!;
        const scale = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
        return {
          width: parseFloat(target.width) * scale,
          height: parseFloat(target.height) * scale,
          transform: getComputedStyle(element).transform,
          countVisible: getComputedStyle(element.querySelector("span")!).display,
        };
      }),
    );
    for (const size of sizes) {
      expect(size.width).toBeGreaterThanOrEqual(24);
      expect(size.height).toBeGreaterThanOrEqual(24);
      expect(size.transform).toBe("none");
      expect(size.countVisible).not.toBe("none");
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
    const branch = page.getByTestId("rf__node-e2e-child").locator(".flow-collapse");
    await expect.poll(() => branch.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const target = getComputedStyle(element, "::before");
      const viewport = element.closest(".react-flow__viewport")!;
      const scale = new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a;
      const x = rect.x + parseFloat(target.width) * scale - 2;
      const y = rect.y + rect.height / 2;
      return document.elementFromPoint(x, y)?.closest(".flow-collapse") === element;
    })).toBe(true);
    if (step < steps - 1) {
      await smaller.click();
      await page.waitForTimeout(350);
    }
  }
  await page.getByTestId("rf__node-e2e-child").locator(".flow-collapse").click();
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
});
