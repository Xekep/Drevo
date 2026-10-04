import type { Page } from "@playwright/test";

export async function openAdminSection(page: Page, _id: string, label: string) {
  await page.getByRole("navigation", { name: "Разделы админки" })
    .getByRole("button", { name: label, exact: true }).click();
}
