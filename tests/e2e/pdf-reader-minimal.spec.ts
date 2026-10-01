import { expect, test } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";

async function samplePdf(paddingBytes = 0, pageCount = 3, mixedSizes = false) {
  const pdf = new PDFDocument({
    autoFirstPage: false,
    compress: !paddingBytes,
  });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  if (paddingBytes) {
    // An unused stream keeps the PDF valid while making full downloads expensive.
    const padding = pdf.ref({});
    padding.end(Buffer.alloc(paddingBytes, 32));
  }
  for (let page = 1; page <= pageCount; page++) {
    pdf.addPage(
      mixedSizes
        ? {
            size: page % 3 === 0 ? "A3" : "A4",
            layout: page % 3 === 2 ? "landscape" : "portrait",
          }
        : undefined,
    );
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
  const csp = readFileSync("ops/nginx.conf", "utf8").match(
    /add_header Content-Security-Policy "([^"]+)"/,
  )![1];
  await page.route("**/bookreader-frame.html", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), "content-security-policy": csp },
    });
  });
  const { reader, book } = await openSample(
    page,
    `BookReader modules ${info.project.name}`,
  );
  await expect(book.locator(".BRtoolbar")).toBeVisible();
  await expect(book.locator(".BRfooter")).toBeVisible();
  await expect(book.locator(".BRtoolbar .share")).toHaveCount(0);
  await book.locator(".BRtoolbar .info").click();
  await expect(book.locator(".BRinfo")).toContainText("Название");
  await expect(book.locator(".BRinfo .floatShut")).not.toHaveAttribute(
    "onclick",
  );
  await book.getByRole("button", { name: "Закрыть сведения" }).click();
  await expect(book.locator("#colorbox")).toBeHidden();
  await expect(reader).toBeVisible();
  await book.locator(".BRtoolbar .info").click();
  await book.locator("body").press("Escape");
  await expect(book.locator("#colorbox")).toBeHidden();
  await expect(reader).toBeVisible();
  const commentsButton = book.getByRole("button", { name: "Комментарии" });
  const sidebar = reader.locator(".pdf-book-sidebar");
  await expect(commentsButton).toBeVisible();
  await expect(commentsButton).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).toBeHidden();
  await commentsButton.click();
  await expect(sidebar).toBeVisible();
  await expect(commentsButton).toHaveAttribute("aria-expanded", "true");
  await commentsButton.click();
  await expect(sidebar).toBeHidden();
  await commentsButton.click();
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
  await book.locator("body").evaluate((body) => {
    window.addEventListener(
      "contextmenu",
      (event) => {
        body.dataset.lensMenuPrevented = String(event.defaultPrevented);
      },
      { once: true },
    );
  });
  await book
    .locator('.BRpage-visible[data-index="1"]')
    .click({ button: "right" });
  await expect(book.locator("body")).toHaveAttribute(
    "data-lens-menu-prevented",
    "true",
  );
  await expect(lensButton).toHaveAttribute("aria-pressed", "false");
  await expect(book.locator(".drevo-magnifier-lens")).toHaveCount(0);
  await expect(reader).toBeVisible();
  await lensButton.click();
  await expect(lensButton).toHaveAttribute("aria-pressed", "true");
  await book.locator("body").press("Escape");
  await expect(lensButton).toHaveAttribute("aria-pressed", "false");
  await expect(book.locator(".drevo-magnifier-lens")).toHaveCount(0);

  await lensButton.click();
  await expect(lensButton).toHaveAttribute("aria-pressed", "true");
  await commentsButton.click();
  await reader.evaluate(() => {
    window.addEventListener(
      "contextmenu",
      (event) => {
        document.body.dataset.lensMenuPrevented = String(
          event.defaultPrevented,
        );
      },
      { once: true },
    );
  });
  await reader
    .locator(".pdf-book-sidebar-tabs button")
    .first()
    .click({ button: "right" });
  await expect(page.locator("body")).toHaveAttribute(
    "data-lens-menu-prevented",
    "true",
  );
  await expect(lensButton).toHaveAttribute("aria-pressed", "false");
  await expect(reader).toBeVisible();
  expect(
    await book
      .locator("body")
      .evaluate((body) =>
        body.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        ),
      ),
  ).toBe(true);
  const pageImage = book
    .locator('.BRpage-visible[data-index="1"] img.BRpageimage')
    .first();
  await expect(pageImage).toHaveAttribute("draggable", "false");
  expect(
    await pageImage.evaluate((image) =>
      image.dispatchEvent(
        new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
      ),
    ),
  ).toBe(false);
  await commentsButton.click();

  await commentsButton.click();
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

test("large PDFs open from byte ranges at the requested page with exact page sizes", async ({
  page,
}) => {
  const data = await samplePdf(5 * 1024 * 1024, 12, true);
  const upload = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({
          title: `Partial PDF ${randomUUID()}`,
          personIds: [],
        }),
      ),
    },
    data,
  });
  expect(upload.status()).toBe(201);
  const { id } = await upload.json();
  const chunks: number[] = [];
  page.on("response", (response) => {
    if (
      response.url().includes(`/api/documents/${id}/file`) &&
      response.status() === 206
    )
      chunks.push(Number(response.headers()["content-length"]));
  });
  await page.goto(`/documents/${id}/page/5`);
  const reader = page.getByRole("dialog");
  const book = reader.frameLocator("iframe.pdf-book-frame");
  const image = book
    .locator('.BRpage-visible[data-index="4"] img.BRpageimage')
    .first();
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((image: HTMLImageElement) => image.naturalWidth))
    .toBeGreaterThan(0);
  const size = await image.evaluate((image: HTMLImageElement) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }));
  expect(size.width / size.height).toBeCloseTo(841.89 / 595.28, 2);
  expect(chunks.length).toBeGreaterThan(0);
  expect(chunks.reduce((sum, length) => sum + length, 0)).toBeLessThan(
    data.length / 4,
  );
  await book.getByRole("button", { name: "Закрыть документ" }).click();
  await expect(reader).toHaveCount(0);
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
  const label = edge.locator(".br-leaf-edges__label");
  const hoverEdge = async () => {
    await edge.hover();
    const bounds = (await edge.boundingBox())!;
    // The native reader fills the label on movement after entering the edge.
    await page.mouse.move(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2 + 4,
    );
    await expect(label).toContainText(/\d+/);
  };
  await hoverEdge();
  await expect(label).toBeVisible();
  expect(
    Number((await label.textContent())!.match(/\d+/)![0]),
  ).toBeGreaterThanOrEqual(1);
  expect(
    Number((await label.textContent())!.match(/\d+/)![0]),
  ).toBeLessThanOrEqual(3);
  const labelBounds = (await label.boundingBox())!;
  expect(labelBounds.width).toBeLessThan(100);
  expect(labelBounds.height).toBeGreaterThan(24);
  expect(labelBounds.height).toBeLessThan(40);
  const renderedFontSize = () =>
    label.evaluate((label) => {
      const book = label.closest(".br-mode-2up__book")!;
      const matrix = new DOMMatrixReadOnly(getComputedStyle(book).transform);
      return (
        parseFloat(getComputedStyle(label).fontSize) *
        Math.hypot(matrix.a, matrix.b)
      );
    });
  await expect.poll(renderedFontSize).toBeGreaterThan(12.5);
  await expect.poll(renderedFontSize).toBeLessThan(13.5);
  await book.locator(".BRicon.zoom_in:visible").first().click();
  await hoverEdge();
  await expect(label).toBeVisible();
  await expect.poll(renderedFontSize).toBeGreaterThan(12.5);
  await expect.poll(renderedFontSize).toBeLessThan(13.5);
  const transform = await book
    .locator(".br-mode-2up__book")
    .evaluate((book) => getComputedStyle(book).transform);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect
    .poll(() =>
      book
        .locator(".br-mode-2up__book")
        .evaluate((book) => getComputedStyle(book).transform),
    )
    .not.toBe(transform);
  await hoverEdge();
  await expect(label).toBeVisible();
  await expect.poll(renderedFontSize).toBeGreaterThan(12.5);
  await expect.poll(renderedFontSize).toBeLessThan(13.5);
  expect(
    await book
      .locator(".br-mode-2up__root")
      .evaluate((root) => root.scrollWidth - root.clientWidth),
  ).toBeLessThanOrEqual(1);
  await book.locator(".BRicon.book_left:visible").first().click();
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible();
});
