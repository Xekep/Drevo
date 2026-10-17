import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

for (const format of ["gedcom551", "gedcom7", "gedzip7"] as const) {
  test(`${format} download works with the production no-referrer policy`, async ({ page, isMobile }, info) => {
    test.skip(isMobile, "Canvas export is a desktop action");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.route("**/tree", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "referrer-policy": "no-referrer" } });
    });
    await page.goto("/tree");
    await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
    await page.locator(".react-flow__pane").click({ button: "right", position: { x: 40, y: 350 } });
    await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
    const dialog = page.getByRole("dialog", { name: "Экспорт древа" });
    await dialog.getByRole("combobox", { name: "Формат экспорта" }).selectOption(format);
    const response = page.waitForResponse(r => r.url().includes("/api/gedcom/export-visible") && r.request().method() === "POST");
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
    const result = await response;
    expect(result.status()).toBe(200);
    expect(result.request().headers().origin).toBe(new URL(page.url()).origin);
    expect(result.headers()["content-disposition"]).toMatch(/attachment/);
    const download = await pending;
    expect(download.suggestedFilename()).toMatch(format === "gedzip7" ? /\.gdz$/ : /\.ged$/);
    const path = info.outputPath(download.suggestedFilename());
    await download.saveAs(path);
    const data = await readFile(path);
    expect(data.subarray(0, format === "gedzip7" ? 2 : 6).toString()).toBe(format === "gedzip7" ? "PK" : "0 HEAD");
    await expect(dialog.getByRole("alert")).toHaveCount(0);
  });
}

test("a rejected genealogy download reports the error without claiming success", async ({ page, isMobile }) => {
  test.skip(isMobile, "Canvas export is a desktop action");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/gedcom/export-visible?**", route => route.fulfill({
    status: 403, json: { error: "Доступ к экспорту отозван" },
  }));
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await page.locator(".react-flow__pane").click({ button: "right", position: { x: 40, y: 350 } });
  await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Экспорт древа" });
  await dialog.getByRole("combobox", { name: "Формат экспорта" }).selectOption("gedcom7");
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Доступ к экспорту отозван");
  await expect(dialog.getByRole("status")).toBeEmpty();
});
