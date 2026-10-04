import type { Page } from "@playwright/test";

export async function openAdminSection(page: Page, id: string, label: string) {
  if (["ai", "storage", "vk", "resources"].includes(id)) {
    await page.getByRole("button", { name: label, exact: true }).click();
    return;
  }
  await page.getByRole("navigation", { name: "Разделы админки" })
    .getByRole("button", { name: label, exact: true }).click();
}
