import { expect, type Page } from "@playwright/test";

export async function finishPersonDetail(page: Page) {
  const detail = page.locator(".person-detail-dialog[open]");
  await expect(detail).toHaveCount(1);
  await detail.getByRole("button", { name: "Готово", exact: true }).click();
}

/** Save the focused sub-editor first; invalid evidence keeps its dialog open. */
export async function savePersonDetails(page: Page) {
  if (await page.locator(".person-detail-dialog[open]").count()) {
    await finishPersonDetail(page);
    if (await page.locator(".person-detail-dialog[open]").count()) return;
  }
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
}
