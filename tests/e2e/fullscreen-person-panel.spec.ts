import { expect, test } from "@playwright/test";

for (const fallback of [false, true]) {
  test(`mobile expanded person fills fullscreen and restores the header offset (${fallback ? "CSS" : "native"})`, async ({ page, isMobile }, info) => {
    test.skip(!isMobile);
    if (fallback) await page.addInitScript(() => {
      Element.prototype.requestFullscreen = () => Promise.reject(new Error("Unavailable"));
    });
    await page.goto("/tree");
    const canvas = page.locator(".tree-canvas");
    await expect(canvas).toHaveAttribute("aria-busy", "false");
    await page.getByRole("button", { name: "Развернуть на весь экран", exact: true }).click();
    await expect(canvas).toHaveClass(/is-fullscreen/);
    await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
    const dock = page.locator(".inspector-dock");
    if (!(await dock.getAttribute("class"))?.includes("expanded"))
      await page.getByRole("button", { name: "Развернуть панель", exact: true }).click();
    await expect(dock).toHaveClass(/expanded/);
    await expect.poll(async () => Math.round((await dock.boundingBox())!.y)).toBe(0);
    await expect.poll(async () => {
      const box = (await dock.boundingBox())!;
      return Math.abs(box.height - await page.evaluate(() => window.innerHeight));
    }).toBeLessThanOrEqual(1);
    await page.screenshot({ path: info.outputPath("fullscreen-person.png") });
    await page.goBack();
    await expect(canvas).not.toHaveClass(/is-fullscreen/);
    // Back also restores the pre-selection route. Reopen outside fullscreen.
    await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").click();
    await expect(dock).toHaveClass(/expanded/);
    await expect.poll(() => dock.evaluate(element => ({ top: getComputedStyle(element).top,
      y: Math.round(element.getBoundingClientRect().y) }))).toEqual({ top: "58px", y: 58 });
  });
}
