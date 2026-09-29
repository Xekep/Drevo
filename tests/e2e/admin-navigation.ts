import type { Page } from "@playwright/test";

export async function openAdminSection(page: Page, id: string, label: string) {
  const mobileSelect = page.locator("#admin-section-select");
  await mobileSelect.waitFor({ state: "attached" });
  if (await mobileSelect.isVisible()) {
    await mobileSelect.selectOption(id);
  } else {
    await page.getByRole("button", { name: label, exact: true }).click();
  }
}
