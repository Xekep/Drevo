import { expect, test } from "@playwright/test";
import PDFDocument from "pdfkit";
import { openAdminSection } from "./admin-navigation";

test("администратор сохраняет источник и связывает его с карточкой", async ({ page }, testInfo) => {
  const title = `Метрическая книга ${testInfo.project.name}`;
  const documentTitle = `Скан источника ${testInfo.project.name}`;
  const pdf = new PDFDocument();
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const data = new Promise<Buffer>((resolve) => pdf.on("end", () => resolve(Buffer.concat(chunks))));
  pdf.text("Archive record");
  pdf.end();
  const uploaded = await page.request.post("/api/documents", {
    headers: { "Content-Type": "application/pdf", "X-Document-Metadata": encodeURIComponent(JSON.stringify({ title: documentTitle, personIds: [] })) },
    data: await data,
  });
  expect(uploaded.status()).toBe(201);
  const documentId = (await uploaded.json()).id;
  await page.goto("/manage");
  await openAdminSection(page, "sources", "Источники");
  await page.getByRole("button", { name: "Добавить источник" }).click();
  const editor = page.locator(".source-catalog-editor");
  await editor.getByLabel("Название").fill(title);
  await editor.getByLabel("Архив", { exact: true }).fill("ГАСО");
  await editor.getByLabel("Фонд").fill("6");
  await editor.getByLabel("Найти документ в архиве").fill(documentTitle);
  await editor.locator(".source-document-results").getByRole("button", { name: documentTitle }).click();
  await expect(editor.locator(".source-document-tags")).toContainText(documentTitle);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".source-catalog-list")).toContainText(title);
  const catalog = await page.request.get("/api/sources?q=Метрическая").then((response) => response.json());
  expect(catalog.sources.find((source: { title: string }) => source.title === title).documentIds).toContain(documentId);
  // Existing linked documents keep their titles outside the search page.
  await page.route("**/api/documents?*", (route) => route.fulfill({ json: { items: [], total: 0 } }));
  await page.reload();
  await page.locator(".source-catalog-list").getByRole("button", { name: new RegExp(title) }).click();
  await expect(editor.locator(".source-document-tags")).toContainText(documentTitle);
  await page.unroute("**/api/documents?*");
  await editor.getByLabel("Название").fill(`${title} исправленная`);
  await page.route("**/api/sources/*", async (route) => {
    if (route.request().method() === "PUT")
      await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Конфликт версии" }) });
    else await route.continue();
  });
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Конфликт версии");
  await expect(editor.getByLabel("Название")).toHaveValue(`${title} исправленная`);
  await page.unroute("**/api/sources/*");
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".source-catalog-list")).toContainText(`${title} исправленная`);

  await editor.getByLabel("Человек").fill("Иван Тестов");
  await page.getByRole("option", { name: /^Тестов Иван Петрович/ }).click();
  await expect(editor.getByLabel("Документ источника").locator("option")).toHaveText(documentTitle);
  await editor.getByLabel("Страница документа").fill("1");
  await editor.getByRole("button", { name: "Привязать", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Источник привязан к факту" })).toBeVisible();
  const response = await page.request.get("/api/family");
  const family = await response.json();
  expect(family.family.people.find((person: { id: string }) => person.id === "e2e-memorial-person")
    .sources.some((source: { title: string; documentId: string; documentPage: number }) =>
      source.title === `${title} исправленная` && source.documentId === documentId && source.documentPage === 1)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
});
