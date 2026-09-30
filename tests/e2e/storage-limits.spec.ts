import { expect, test } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

test("лимиты хранилища по ролям сохраняются в компактной форме", async ({
  page,
}, testInfo) => {
  await page.goto("/admin");
  await openAdminSection(page, "storage", "Хранилище");
  const form = page.getByRole("form", { name: "Лимиты хранилища" });
  await form.getByLabel("Лимит: Родственник", { exact: true }).fill("500");
  await form.getByLabel("Лимит: Исследователь", { exact: true }).fill("2000");
  await form.getByRole("button", { name: "Сохранить лимиты" }).click();
  await expect(form.getByRole("status")).toHaveText("Лимиты сохранены");
  await page.reload();
  await openAdminSection(page, "storage", "Хранилище");
  await expect(
    form.getByLabel("Лимит: Родственник", { exact: true }),
  ).toHaveValue("500");
  await expect(
    form.getByLabel("Лимит: Исследователь", { exact: true }),
  ).toHaveValue("2000");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("storage-limits.png") });
});
