import { expect, test } from "@playwright/test";
import PDFDocument from "pdfkit";

async function samplePdf() {
  const pdf = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  for (let index = 1; index <= 3; index++) {
    pdf.addPage();
    pdf.text(`Archive page ${index}`);
  }
  pdf.end();
  return done;
}

test("участник загружает PDF и листает его как книгу", async ({ page }, testInfo) => {
  const title = `Архивный документ ${testInfo.project.name}`;
  await page.goto("/documents");
  await expect(page.getByRole("heading", { name: "Документы" })).toBeVisible();
  await page.getByRole("button", { name: "Добавить PDF" }).click();
  const form = page.locator(".documents-upload");
  await form.locator('input[type="file"]').setInputFiles({
    name: "archive.pdf", mimeType: "application/pdf", buffer: await samplePdf(),
  });
  await form.getByLabel("Название").fill(title);
  await form.getByLabel("Найти человека для документа").fill("Тестов Иван");
  await expect(form.locator(".documents-person-results button").first()).toBeVisible();
  await form.locator(".documents-person-results button").first().click();
  await form.getByRole("button", { name: "Добавить документ" }).click();
  const item = page.locator(".document-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await page.getByLabel("Найти документ или человека").fill("архивный документ");
  await expect(item).toBeVisible();
  await page.getByLabel("Найти документ или человека").fill("несуществующий документ");
  await expect(page.getByText("По запросу ничего не найдено.")).toBeVisible();
  await page.getByRole("button", { name: "Очистить поиск" }).click();
  await expect(item).toBeVisible();
  await item.click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await expect(reader).toBeVisible();
  await expect(reader.getByText("1 из 3")).toBeVisible({ timeout: 15_000 });
  await reader.getByRole("button", { name: "Следующая страница" }).click();
  await expect(reader.locator(".pdf-book-footer")).toContainText(/2|3/);
  await reader.getByRole("button", { name: "Закрыть документ" }).click();
  await expect(reader).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
