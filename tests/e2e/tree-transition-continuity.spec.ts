import { expect, test } from "@playwright/test";

test("family layout keeps the focused card mounted throughout its move", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/people/e2e-child");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  await page.waitForTimeout(900);
  const card = page.getByTestId("rf__node-e2e-child");
  const original = await card.evaluateHandle((node) => node);
  const samples = await canvas.evaluateHandle((root) => {
    const state = {
      removed: false,
      transforms: new Set<string>(),
      stop: () => {},
    };
    const node = root.querySelector<HTMLElement>(
      '[data-testid="rf__node-e2e-child"]',
    )!;
    let frame = 0;
    const tick = () => {
      state.removed ||= !node.isConnected;
      state.transforms.add(getComputedStyle(node).transform);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    state.stop = () => cancelAnimationFrame(frame);
    return state;
  });
  await page.getByRole("button", { name: "Семья выбранного" }).click();
  await page.waitForTimeout(1200);
  await samples.evaluate((s) => s.stop());
  expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  expect(await samples.evaluate((s) => s.removed)).toBe(false);
  expect(await samples.evaluate((s) => s.transforms.size)).toBeGreaterThan(3);
});

test("fan reveals intermediate opacity on every opening", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/people/e2e-child");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  await page.waitForTimeout(900);
  for (let opening = 0; opening < 2; opening++) {
    const samples = await canvas.evaluateHandle((root) => {
      const state = { intermediate: false, hidden: false, stop: () => {} };
      let frame = 0;
      const tick = () => {
        const sector = root.querySelector('[data-fan-generation="4"]');
        if (sector) {
          const opacity = Number(getComputedStyle(sector).opacity);
          state.hidden ||= opacity === 0;
          state.intermediate ||= opacity > 0 && opacity < 1;
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      state.stop = () => cancelAnimationFrame(frame);
      return state;
    });
    await page.getByRole("button", { name: "Веер", exact: true }).click();
    await expect
      .poll(() => samples.evaluate((s) => s.hidden && s.intermediate))
      .toBe(true);
    await expect(canvas).not.toHaveClass(/is-fan-revealing/);
    await samples.evaluate((s) => s.stop());
    await page.getByRole("button", { name: "Закрыть веер" }).click();
  }
});
