import { expect, test } from "@playwright/test";
import PDFDocument from "pdfkit";
import { readFileSync } from "node:fs";

test.beforeEach(async ({ page }) => {
  const csp = readFileSync("ops/nginx.conf", "utf8").match(
    /add_header Content-Security-Policy "([^"]+)"/,
  )![1];
  await page.route("**/documents", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": csp },
    });
  });
});

async function samplePdf(count = 3, landscape = false) {
  const pdf = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  for (let index = 1; index <= count; index++) {
    pdf.addPage({ layout: landscape ? "landscape" : "portrait" });
    pdf.text(`Archive page ${index}`);
  }
  pdf.end();
  return done;
}

test("участник загружает PDF и листает его как книгу", async ({
  page,
}, testInfo) => {
  const title = `Архивный документ ${testInfo.project.name}`;
  await page.goto("/documents");
  await expect(page.getByRole("heading", { name: "Документы" })).toBeVisible();
  await page.getByRole("button", { name: "Добавить PDF" }).click();
  const form = page.locator(".documents-upload");
  await form.locator('input[type="file"]').setInputFiles({
    name: "archive.pdf",
    mimeType: "application/pdf",
    buffer: await samplePdf(),
  });
  await form.getByLabel("Название").fill(title);
  await form.getByLabel("Найти человека для документа").fill("Тестов Иван");
  await expect(
    form.locator(".documents-person-results button").first(),
  ).toBeVisible();
  await form.locator(".documents-person-results button").first().click();
  await form.getByRole("button", { name: "Добавить документ" }).click();
  const item = page.locator(".document-item").filter({ hasText: title });
  await expect(item).toBeVisible();
  await page
    .getByLabel("Найти документ или человека")
    .fill("архивный документ");
  await expect(item).toBeVisible();
  await page
    .getByLabel("Найти документ или человека")
    .fill("несуществующий документ");
  await expect(page.getByText("По запросу ничего не найдено.")).toBeVisible();
  await page.getByRole("button", { name: "Очистить поиск" }).click();
  await expect(item).toBeVisible();
  await item.click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await expect(reader).toBeVisible();
  await expect(reader.getByText("1 из 3")).toBeVisible({ timeout: 15_000 });
  await expect
    .poll(() =>
      reader
        .locator('[data-page="0"] img')
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  const firstPage = reader.locator('[data-page="0"] img').first();
  await expect(firstPage).toBeVisible();
  const [bounds, stage] = await Promise.all([
    firstPage.boundingBox(),
    reader.locator(".pdf-book-stage").boundingBox(),
  ]);
  expect(bounds!.height).toBeGreaterThan(
    testInfo.project.name === "desktop" ? stage!.height * 0.9 : 350,
  );
  expect(bounds!.width).toBeGreaterThan(250);
  await expect
    .poll(async () => {
      const [pageBox, stageBox] = await Promise.all([
        firstPage.boundingBox(),
        reader.locator(".pdf-book-stage").boundingBox(),
      ]);
      return Math.abs(
        pageBox!.x + pageBox!.width / 2 - stageBox!.x - stageBox!.width / 2,
      );
    })
    .toBeLessThan(3);
  await expect(reader.locator('[role="alert"]')).toHaveCount(0);
  await reader.screenshot({
    path: `work/pdf-reader-${testInfo.project.name}.png`,
  });
  await reader.getByRole("button", { name: "Следующая страница" }).click();
  await expect(reader.locator(".pdf-book-footer")).toContainText(/2|3/);
  await expect
    .poll(() =>
      reader
        .locator('[data-page="1"] img')
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 600 });
    await expect(reader.locator('[data-page="1"] img').first()).toBeVisible();
    expect(
      await reader.evaluate(
        (element) => element.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }
  page.once("dialog", (dialog) => dialog.dismiss());
  await reader
    .getByRole("button", { name: "Удалить документ", exact: true })
    .click();
  await expect(reader).toBeVisible();
  await reader.getByRole("button", { name: "Закрыть документ" }).click();
  await expect(reader).toBeHidden();
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: `Удалить документ «${title}»`, exact: true })
    .click();
  await expect(item).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth + 1,
    ),
  ).toBe(true);
});

for (const variant of ["one-page", "landscape", "damaged"] as const) {
  test(`PDF reader handles ${variant} documents`, async ({
    page,
  }, testInfo) => {
    const title = `${variant}-${testInfo.project.name}`;
    const response = await page.request.post("/api/documents", {
      headers: {
        "Content-Type": "application/pdf",
        "X-Document-Metadata": encodeURIComponent(
          JSON.stringify({ title, personIds: ["e2e-child"] }),
        ),
      },
      data:
        variant === "damaged"
          ? Buffer.from("%PDF-1.7\ninvalid test PDF")
          : await samplePdf(
              variant === "one-page" ? 1 : 4,
              variant === "landscape",
            ),
    });
    expect(response.status()).toBe(201);
    const { id } = await response.json();
    await page.goto("/documents");
    await page.locator(".document-item").filter({ hasText: title }).click();
    const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
    if (variant === "damaged") {
      await expect(reader.getByRole("alert")).toBeVisible();
      await expect(
        reader
          .getByRole("alert")
          .getByRole("link", { name: "Открыть оригинал" }),
      ).toBeVisible();
    } else {
      const image = reader.locator('[data-page="0"] img').first();
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBeGreaterThan(0);
      const rect = await image.boundingBox();
      await expect
        .poll(async () => {
          const [pageBox, stageBox] = await Promise.all([
            image.boundingBox(),
            reader.locator(".pdf-book-stage").boundingBox(),
          ]);
          return Math.abs(
            pageBox!.x + pageBox!.width / 2 - stageBox!.x - stageBox!.width / 2,
          );
        })
        .toBeLessThan(3);
      expect(rect!.width).toBeGreaterThan(100);
      expect(rect!.height).toBeGreaterThan(100);
      if (variant === "landscape")
        expect(rect!.width / rect!.height).toBeGreaterThan(1.2);
      else
        await expect(
          reader.getByRole("button", { name: "Следующая страница" }),
        ).toBeDisabled();
    }
    page.once("dialog", (dialog) => dialog.accept());
    await reader
      .getByRole("button", { name: "Удалить документ", exact: true })
      .click();
    await expect(reader).toBeHidden();
    expect((await page.request.get(`/api/documents/${id}/file`)).status()).toBe(
      404,
    );
  });
}
