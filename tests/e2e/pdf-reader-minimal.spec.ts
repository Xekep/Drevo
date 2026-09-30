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
  for (let page = 1; page <= 3; page++) {
    pdf.addPage();
    pdf.text(`Archive page ${page}`);
    if (page === 2) pdf.outline.addItem("Вторая страница");
  }
  pdf.end();
  return done;
}

test("PDF opens as a book with compact controls and an optional outline", async ({
  page,
}, info) => {
  const title = `Reader minimal ${info.project.name}`;
  const upload = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: [] }),
      ),
    },
    data: await samplePdf(),
  });
  expect(upload.status()).toBe(201);
  await page.goto("/documents");
  await page.locator(".document-item").filter({ hasText: title }).click();
  expect(page.url()).toMatch(/\/documents\/[a-f0-9-]{36}$/);
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await expect(reader).toBeVisible();
  await expect(reader.locator(".pdf-book-pages")).toBeVisible();
  await expect
    .poll(() =>
      reader
        .locator('.pdf-book-page[data-page="1"] img')
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(reader.getByRole("heading")).toHaveCount(0);
  await expect(reader.locator(".pdf-book-info")).toHaveCount(0);
  await expect(
    reader.getByRole("button", { name: "Сведения о документе" }),
  ).toBeVisible();
  if (info.project.name === "mobile")
    await reader
      .getByRole("button", { name: "Комментарии", exact: true })
      .click();
  await reader.getByRole("button", { name: "Оглавление" }).click();
  await reader
    .getByRole("navigation", { name: "Оглавление документа" })
    .getByRole("button", { name: /Вторая страница/ })
    .click();
  await expect
    .poll(() => reader.locator(".pdf-book-page-count").textContent())
    .toContain("2");
  await reader.getByRole("button", { name: "Лупа" }).click();
  await expect(reader.getByRole("button", { name: "Лупа" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const magnifiedPage = reader.locator('.pdf-book-page[data-page="1"]');
  await magnifiedPage.hover({ position: { x: 120, y: 120 } });
  await expect(
    magnifiedPage.locator('div[style*="border-radius: 50%"]'),
  ).toBeVisible();
  await reader.screenshot({ path: info.outputPath("pdf-reader-lens.png") });
  await page.keyboard.press("Escape");
  await expect(reader.getByRole("button", { name: "Лупа" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  if (info.project.name === "mobile")
    await reader.locator(".pdf-book-sidebar-toggle").click();
  await reader
    .locator(".pdf-book-sidebar-tabs")
    .getByRole("button", { name: "Комментарии" })
    .click();
  await reader.getByRole("button", { name: "Выделить фрагмент" }).click();
  const overlay = reader.locator(
    '.pdf-book-page[data-page="1"] .pdf-book-overlay',
  );
  const area = await overlay.boundingBox();
  expect(area?.width).toBeGreaterThan(100);
  await page.mouse.move(
    area!.x + area!.width * 0.2,
    area!.y + area!.height * 0.3,
  );
  await page.mouse.down();
  await page.mouse.move(
    area!.x + area!.width * 0.42,
    area!.y + area!.height * 0.43,
    { steps: 5 },
  );
  await page.mouse.up();
  await reader
    .getByRole("textbox", { name: "Комментарий к фрагменту" })
    .fill("Важный фрагмент");
  await reader.getByRole("button", { name: "Сохранить" }).click();
  await expect(reader.getByText("Важный фрагмент")).toBeVisible();
  await reader.screenshot({ path: info.outputPath("pdf-reader-minimal.png") });
});

test("cover and spread stay centered during both page turns", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Landscape spreads need a desktop viewport",
  );
  const title = `Reader cover ${info.project.name}`;
  const upload = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: [] }),
      ),
    },
    data: await samplePdf(),
  });
  expect(upload.status()).toBe(201);
  await page.goto("/documents");
  await page.locator(".document-item").filter({ hasText: title }).click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await expect(
    reader.locator('.pdf-book-page[data-page="0"] img'),
  ).toBeVisible();

  for (const label of ["Следующая страница", "Предыдущая страница"]) {
    const offsets = await reader.evaluate(async (dialog, buttonLabel) => {
      const root = dialog.querySelector<HTMLElement>(".pdf-book-pages")!;
      const button = dialog.querySelector<HTMLButtonElement>(
        `[aria-label="${buttonLabel}"]`,
      )!;
      const samples: number[] = [];
      const start = performance.now();
      button.click();
      await new Promise<void>((resolve) => {
        const sample = () => {
          samples.push(
            new DOMMatrixReadOnly(getComputedStyle(root).transform).m41,
          );
          if (performance.now() - start < 800) requestAnimationFrame(sample);
          else resolve();
        };
        requestAnimationFrame(sample);
      });
      return samples;
    }, label);
    const distance = Math.abs(offsets.at(-1)! - offsets[0]);
    const largestStep = Math.max(
      ...offsets
        .slice(1)
        .map((offset, index) => Math.abs(offset - offsets[index])),
    );
    expect(distance).toBeGreaterThan(60);
    expect(largestStep).toBeLessThan(distance * 0.25);
  }
  await expect(reader.locator(".pdf-book-page-count")).toContainText("1 / 3");
});
