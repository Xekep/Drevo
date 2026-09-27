import type { Page } from "@playwright/test";

export async function familyViewAction(page: Page, name: string) {
  const menu = page.getByLabel("Область просмотра", { exact: true });
  if (await page.locator(".tree-family-menu").count()) await menu.click();
  await page.getByRole("button", { name, exact: true }).click();
}

export async function showTree(page: Page) {
  const toggle = page.getByRole("switch", { name: "Древо / Хронология" });
  if (await toggle.count()) await toggle.click();
  else await page.getByRole("button", { name: "Древо", exact: true }).click();
}
