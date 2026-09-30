import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
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

async function openSample(
  page: import("@playwright/test").Page,
  title: string,
) {
  const uniqueTitle = `${title} ${randomUUID()}`;
  const upload = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: uniqueTitle, personIds: [] }),
      ),
    },
    data: await samplePdf(),
  });
  expect(upload.status()).toBe(201);
  await page.goto("/documents");
  await page.locator(".document-item").filter({ hasText: uniqueTitle }).click();
  const reader = page.getByRole("dialog");
  const book = reader.frameLocator("iframe.pdf-book-frame");
  await expect(book.locator(".BRfooter")).toBeVisible();
  await expect
    .poll(() =>
      book
        .locator('.BRpage-visible[data-index="0"] img.BRpageimage')
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  return { reader, book };
}

test("BookReader keeps its navigation and Drevo comments and lens", async ({
  page,
}, info) => {
  const { reader, book } = await openSample(
    page,
    `BookReader modules ${info.project.name}`,
  );
  await expect(book.locator(".BRtoolbar")).toBeVisible();
  await expect(book.locator(".BRfooter")).toBeVisible();
  await expect(book.locator(".BRtoolbar .share")).toHaveCount(0);
  await book.locator(".BRtoolbar .info").click();
  await expect(book.locator(".BRinfo")).toContainText("Название");
  await book.locator("body").press("Escape");
  await expect(book.locator("#colorbox")).toBeHidden();
  await expect(reader).toBeVisible();
  if (info.project.name === "mobile")
    await book.getByRole("button", { name: "Комментарии" }).click();
  await reader.locator(".pdf-book-sidebar-tabs button").last().click();
  await reader.locator(".pdf-book-outline button").first().click();
  await expect(book.locator('.BRpage-visible[data-index="1"]')).toBeVisible();

  const lensButton = book.getByRole("button", { name: "Лупа" });
  await lensButton.click();
  await expect(book.locator("body.drevo-magnifying")).toHaveCount(1);
  await book.locator('.BRpage-visible[data-index="1"]').hover();
  await expect(book.locator(".drevo-magnifier-lens")).toBeVisible();
  await expect(book.locator(".drevo-magnifier-lens")).toHaveCSS(
    "width",
    "180px",
  );
  await book.locator("body").press("Escape");
  await expect(lensButton).toHaveAttribute("aria-pressed", "false");
  await expect(book.locator(".drevo-magnifier-lens")).toHaveCount(0);

  if (info.project.name === "mobile")
    await book.getByRole("button", { name: "Комментарии" }).click();
  await reader.locator(".pdf-book-sidebar-tabs button").first().click();
  await reader.locator(".pdf-book-add-comment").click();
  await expect(book.locator("body.drevo-annotating")).toHaveCount(1);
  const overlay = book.locator(
    '.BRpage-visible[data-index="1"] .drevo-page-layer',
  );
  const bounds = (await overlay.boundingBox())!;
  await page.mouse.move(
    bounds.x + bounds.width * 0.2,
    bounds.y + bounds.height * 0.3,
  );
  await page.mouse.down();
  await page.mouse.move(
    bounds.x + bounds.width * 0.4,
    bounds.y + bounds.height * 0.42,
    {
      steps: 5,
    },
  );
  await page.mouse.up();
  await reader
    .locator(".pdf-book-comment-form textarea")
    .fill("Важный фрагмент");
  await reader.locator(".pdf-book-comment-form button").first().click();
  await expect(reader.getByText("Важный фрагмент")).toBeVisible();
  await expect(
    book.locator('.BRpage-visible[data-index="1"] .drevo-page-mark'),
  ).toHaveCount(1);
});

test("BookReader turns the cover and preloads the next spread", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "Two-page spread needs a desktop viewport",
  );
  const { book } = await openSample(
    page,
    `BookReader flip ${info.project.name}`,
  );
  await book.locator(".BRicon.book_right:visible").first().click();
  await expect(book.locator('.BRpage-visible[data-index="1"]')).toBeVisible();
  await expect(book.locator('.BRpage-visible[data-index="2"]')).toBeVisible();
  for (const index of [1, 2]) {
    await expect
      .poll(() =>
        book
          .locator(`.BRpage-visible[data-index="${index}"] img.BRpageimage`)
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
  }
  await expect(book.locator(".br-mode-2up__leafs--flipping")).toHaveCount(0);
  const edge = book.locator("br-leaf-edges:visible").last();
  await edge.hover();
  const label = edge.locator(".br-leaf-edges__label");
  await expect(label).toBeVisible();
  const labelBounds = (await label.boundingBox())!;
  expect(labelBounds.width).toBeLessThan(100);
  expect(labelBounds.height).toBeLessThan(40);
  expect(
    await book.locator(".br-mode-2up__root").evaluate((root) =>
      root.scrollWidth - root.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await book.locator(".BRicon.book_left:visible").first().click();
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible();
});
