import { expect, test } from "@playwright/test";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences";

for (const presentation of ["flat", "depth"] as const) {
  test(`sharing belongs to the explicit anchor row in ${presentation}`, async ({ page }, info) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    let preferences: TreePreferences = {
      ...DEFAULT_TREE_PREFERENCES,
      presentation,
      animateOnLoad: false,
      generationLimits: null,
    };
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), treePreferences: preferences } });
    });
    await page.route("**/api/tree-preferences", async (route) => {
      if (route.request().method() === "PUT") preferences = route.request().postDataJSON();
      await route.fulfill({ json: preferences });
    });
    await page.goto("/tree");
    const canvas = page.locator(".tree-canvas");
    await expect(canvas).toHaveAttribute("data-layout-ready", "true");
    if (presentation === "depth") await expect(page.locator(".tree-spatial")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Поделиться", exact: true, includeHidden: true })).toHaveCount(0);

    preferences.generationLimits = { anchorId: "e2e-child", ancestors: 3, descendants: 1, collateral: 0 };
    await page.reload();
    if (presentation === "depth") await expect(page.locator(".tree-spatial")).toHaveAttribute("aria-busy", "false");
    const status = canvas.getByRole("status", { name: "Опорный человек" });
    const share = status.getByRole("button", { name: "Поделиться", exact: true });
    await expect(share).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Поделиться", exact: true, includeHidden: true })).toHaveCount(1);
    const widths = info.project.name === "mobile" ? [320, 390] : [1024, 1440];
    for (const width of widths) {
      await page.setViewportSize({ width, height: 900 });
      const name = (await status.locator(".tree-family-name").boundingBox())!;
      const button = (await share.boundingBox())!;
      const reset = (await status.getByRole("button", { name: "Снять ограничения поколений" }).boundingBox())!;
      expect(Math.abs(name.y + name.height / 2 - button.y - button.height / 2)).toBeLessThan(2);
      expect(Math.abs(reset.y + reset.height / 2 - button.y - button.height / 2)).toBeLessThan(2);
      expect(button.x + button.width).toBeLessThanOrEqual(width);
    }
    await page.screenshot({ path: info.outputPath(`anchor-share-${presentation}.png`) });
    await share.click();
    const dialog = page.getByRole("dialog", { name: "Поделиться семьёй" });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".share-members")).toContainText("4 человек");
    await dialog.getByRole("button", { name: "Закрыть" }).click();
    await status.getByRole("button", { name: "Снять ограничения поколений" }).click();
    await expect(status).toHaveCount(0);
    await expect(canvas.getByRole("button", { name: "Поделиться", exact: true, includeHidden: true })).toHaveCount(0);
  });
}
