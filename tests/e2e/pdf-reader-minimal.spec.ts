import { expect } from "@playwright/test";
import { test } from "./fixtures/document-server";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";

async function samplePdf(
  paddingBytes = 0,
  pageCount = 3,
  mixedSizes = false,
  withText = true,
) {
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
    if (withText) pdf.text(`Archive page ${page}`);
    else pdf.rect(72, 72, 100, 100).fill("#aaa");
    if (page === 2) pdf.outline.addItem("Вторая страница");
  }
  pdf.end();
  return done;
}

async function openSample(
  page: import("@playwright/test").Page,
  title: string,
  pdf?: Buffer,
) {
  const uniqueTitle = `${title} ${randomUUID()}`;
  const upload = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: uniqueTitle, personIds: [] }),
      ),
    },
    data: pdf ?? (await samplePdf()),
  });
  expect(upload.status()).toBe(201);
  const { id } = await upload.json();
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
  return { reader, book, id: id as string };
}

test("book and annotation clicks keep comments open", async ({
  page,
}, info) => {
  const { reader, book, id } = await openSample(
    page,
    "Comment panel reading",
  );
  const created = await page.request.post(`/api/documents/${id}/annotations`, {
    data: {
      page: 2,
      x: 0.2,
      y: 0.2,
      width: 0.3,
      height: 0.1,
      text: "Комментарий к фрагменту",
    },
  });
  expect(created.status()).toBe(201);
  await page.goto(`/documents/${id}/page/2`);
  const mark = book
    .locator('.BRpage-visible[data-index="1"] .drevo-page-mark')
    .first();
  await mark.click();
  const sidebar = reader.locator(".pdf-book-sidebar");
  const toggle = book.locator(".drevo-toolbar-comments");
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await reader.getByText("Комментарий к фрагменту", { exact: true }).click();
  await expect(sidebar).toBeVisible();

  const tapBook = async () => {
    const image = book
      .locator(".BRpage-visible img.BRpageimage:visible")
      .first();
    const bounds = (await image.boundingBox())!;
    const panelBounds = (await sidebar.boundingBox())!;
    // Mobile comments overlay most of the page; tap the exposed part of the book.
    const x = Math.min(bounds.x + bounds.width / 2, panelBounds.x - 12);
    const y = Math.min(
      bounds.y + bounds.height * 0.65,
      page.viewportSize()!.height - 100,
    );
    expect(x).toBeGreaterThan(bounds.x);
    if (info.project.name === "mobile") await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await expect(sidebar).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await expect(reader).toBeVisible();
  };
  await tapBook();
  if (info.project.name === "desktop") {
    await book.locator(".BRicon.onepg:visible").first().click();
    await expect(book.locator("br-mode-1up")).toBeVisible();
    await tapBook();
  }
});

test("mobile right swipes dismiss comments without hijacking scrolling or editing", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile");
  const { reader, book, id } = await openSample(page, "Comment panel swipe");
  for (let index = 0; index < 12; index++) {
    const created = await page.request.post(
      `/api/documents/${id}/annotations`,
      {
        data: {
          page: 1,
          x: 0.1,
          y: 0.2,
          width: 0.3,
          height: 0.1,
          text: `Комментарий ${index + 1}. Подробности архивной записи.\nТекст можно читать и копировать.`,
        },
      },
    );
    expect(created.status()).toBe(201);
  }
  await page.reload();
  const sidebar = reader.locator(".pdf-book-sidebar");
  const toggle = book.locator(".drevo-toolbar-comments");
  const comments = reader.locator(".pdf-book-comments");
  await toggle.click();
  await expect(comments.locator("article")).toHaveCount(12);

  const swipe = async (
    target: import("@playwright/test").Locator,
    dx: number,
    dy = 0,
  ) => {
    const bounds = (await target.boundingBox())!;
    const x = bounds.x + Math.min(100, bounds.width / 2);
    const y = bounds.y + Math.min(140, bounds.height / 2);
    const session = await page.context().newCDPSession(page);
    try {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      for (const progress of [1 / 4, 1 / 2, 3 / 4, 1]) {
        await session.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x: x + dx * progress, y: y + dy * progress }],
        });
        await page.waitForTimeout(25);
      }
      await session.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } finally {
      await session.detach();
    }
  };
  // Vertical reading and short/leftward movements must not dismiss the panel.
  await swipe(comments, 0, -100);
  await expect
    .poll(() => comments.evaluate((node) => node.scrollTop))
    .toBeGreaterThan(0);
  await expect(sidebar).toBeVisible();
  await swipe(comments, -70);
  await expect(sidebar).toBeVisible();
  await swipe(comments, 25);
  await expect(sidebar).toBeVisible();
  await swipe(comments, 110);
  await expect(sidebar).toBeHidden();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(reader).toBeVisible();
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible();

  // Dismissing and reopening also preserves an unfinished edit.
  await toggle.click();
  await comments.evaluate((node) => {
    node.scrollTop = 0;
  });
  await comments.locator(".pdf-book-comment-edit").first().click();
  const edit = reader.getByRole("textbox", { name: "Изменить комментарий" });
  await edit.fill("Незавершённый черновик");
  await swipe(edit, 100);
  await expect(sidebar).toBeVisible();
  await expect(edit).toHaveValue("Незавершённый черновик");
  await swipe(reader.locator(".pdf-book-sidebar-tabs"), 110);
  await expect(sidebar).toBeHidden();
  await toggle.click();
  await expect(edit).toHaveValue("Незавершённый черновик");
});

test("BookReader searches the PDF text layer and navigates native highlights", async ({
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
    `PDF search ${info.project.name}`,
  );
  const externalRequests: string[] = [];
  expect(
    await book
      .locator("body")
      .evaluate(
        () =>
          (window as unknown as { jQuery: { ui: { version: string } } }).jQuery
            .ui.version,
      ),
  ).toBe("1.14.2");
  page.on("request", (request) => {
    if (/archive\.org|inside\.php/.test(request.url()))
      externalRequests.push(request.url());
  });
  const query = book.getByRole("searchbox", { name: "Поиск в документе" });
  await expect(query).toBeVisible();
  await query.fill("aRcHiVe pAgE 3");
  await query.press("Enter");
  await expect(book.locator('.BRpage-visible[data-index="2"]')).toBeVisible();
  await expect(
    book
      .locator('.BRpage-visible[data-index="2"] .searchHiliteLayer rect')
      .first(),
  ).toBeVisible();
  await expect(book.locator('[data-id="resultsCount"]')).toHaveText("1 / 1");
  const selected = book
    .locator(".BRpage-visible .searchHiliteLayer rect.is-current-match")
    .first();
  await expect(selected).toBeVisible();
  await expect(selected).toHaveCSS("fill", "rgba(255, 174, 40, 0.55)");
  await expect(selected).toHaveCSS("animation-name", "none");
  await expect(selected).toHaveCSS("vector-effect", "non-scaling-stroke");
  await query.fill("archive");
  await query.press("Enter");
  await expect(book.locator(".BRnavMain .BRnavline .BRsearch")).toHaveCount(3);
  await expect(book.locator('[data-id="resultsCount"]')).toHaveText("1 / 3");
  await book.getByRole("button", { name: "Следующее совпадение" }).click();
  await expect(book.locator('[data-id="resultsCount"]')).toHaveText("2 / 3");
  await expect(
    book
      .locator(
        ".BRpage-visible .searchHiliteLayer rect.match-index-1.is-current-match",
      )
      .first(),
  ).toBeVisible();
  await expect(
    book.locator(".searchHiliteLayer rect.match-index-0.is-current-match"),
  ).toHaveCount(0);
  await expect(
    book
      .locator('.BRpage-visible[data-index="1"] .searchHiliteLayer rect')
      .first(),
  ).toBeVisible();
  await book.getByRole("button", { name: "Очистить поиск" }).click();
  await expect(book.locator(".searchHiliteLayer")).toHaveCount(0);
  await expect(book.locator(".BRnavline .BRsearch")).toHaveCount(0);
  await book.locator("body").press("Control+f");
  await expect(query).toBeFocused();
  await reader.evaluate((element) => {
    element.tabIndex = -1;
    element.focus();
  });
  await page.keyboard.press("Control+f");
  await expect(query).toBeFocused();
  await query.fill("archive");
  await query.press("Enter");
  await query.fill("Archive page 3");
  await query.press("Enter");
  await expect(book.locator('[data-id="resultsCount"]')).toHaveText("1 / 1");
  await expect(book.locator(".BRnavMain .BRnavline .BRsearch")).toHaveCount(1);
  await expect(
    book
      .locator('.BRpage-visible[data-index="2"] .searchHiliteLayer rect')
      .first(),
  ).toBeVisible();
  await query.fill("absent-word");
  await query.press("Enter");
  await expect(book.locator(".search_modal")).toHaveText(
    "Совпадений не найдено.",
  );
  await query.press("Escape");
  await expect(reader).toBeVisible();
  await expect(query).toHaveValue("");
  expect(externalRequests).toEqual([]);
  expect(
    await book
      .locator(".BRtoolbar")
      .evaluate((bar) => bar.scrollWidth - bar.clientWidth),
  ).toBeLessThanOrEqual(1);
});

test("BookReader explains when a PDF has no text layer", async ({
  page,
}, info) => {
  const { reader, book } = await openSample(
    page,
    `PDF without text ${info.project.name}`,
    await samplePdf(0, 1, false, false),
  );
  const query = book.getByRole("searchbox", { name: "Поиск в документе" });
  await query.fill("archive");
  await query.press("Enter");
  await expect(book.locator(".search_modal")).toHaveText(
    "В PDF нет текстового слоя.",
  );
  await query.press("Escape");
  await expect(reader).toBeVisible();
  await expect(book.locator(".searchHiliteLayer")).toHaveCount(0);
});

test("BookReader keeps its navigation and Drevo comments and lens", async ({
  page,
}, info) => {
  if (info.project.name === "mobile")
    await page.setViewportSize({ width: 320, height: 640 });
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
  const commentsButton = book.locator(".drevo-toolbar-comments");
  const sidebar = reader.locator(".pdf-book-sidebar");
  await expect(commentsButton).toBeVisible();
  await expect(commentsButton).toHaveAttribute("aria-expanded", "false");
  await expect(sidebar).toBeHidden();
  await commentsButton.focus();
  await commentsButton.press("Enter");
  await expect(sidebar).toBeVisible();
  await expect(commentsButton).toHaveAttribute("aria-expanded", "true");
  await expect(commentsButton).toBeHidden();
  const closePanel = reader.getByRole("button", {
    name: "Закрыть панель комментариев",
  });
  await expect(closePanel).toBeFocused();
  if (info.project.name === "mobile") {
    const toolbarBottom = await book
      .locator(".BRtoolbar")
      .evaluate((bar) => bar.getBoundingClientRect().bottom);
    await expect
      .poll(() =>
        sidebar.evaluate((panel) => panel.getBoundingClientRect().top),
      )
      .toBeGreaterThanOrEqual(toolbarBottom);
  }
  await closePanel.click();
  await expect(sidebar).toBeHidden();
  await expect(commentsButton).toBeVisible();
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
  await closePanel.click();

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

test("PDF modal keeps keyboard focus across iframe and sidebar controls", async ({
  page,
}, info) => {
  const { reader, book } = await openSample(page, `Focus ${info.project.name}`);
  await book.getByRole("button", { name: "Комментарии" }).click();
  await book.locator("body").evaluate(() => {
    const controls = Array.from(
      document.querySelectorAll<HTMLElement>(
        "a[href],button,input,select,textarea,[tabindex]",
      ),
    ).filter(
      (element) =>
        element.tabIndex >= 0 &&
        element.getClientRects().length &&
        !element.matches(":disabled"),
    );
    controls.at(-1)?.focus();
  });
  for (const key of ["Tab", "Tab", "Shift+Tab", "Shift+Tab"]) {
    await page.keyboard.press(key);
    expect(
      await reader.evaluate((dialog) =>
        dialog.contains(document.activeElement),
      ),
    ).toBe(true);
  }
  await book.getByRole("button", { name: "Закрыть документ" }).click();
  await expect(reader).toHaveCount(0);
});

test("PDF page URLs stay bounded and evicted pages can be revisited", async ({
  page,
}, info) => {
  test.skip(
    info.project.name === "mobile",
    "The same renderer is shared by both layouts",
  );
  await page.addInitScript(() => {
    const urls = new Set<string>();
    const create = URL.createObjectURL,
      revoke = URL.revokeObjectURL;
    URL.createObjectURL = (object) => {
      const url = create(object);
      if (object instanceof Blob && object.type === "image/webp") urls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      urls.delete(url);
      revoke(url);
    };
    Object.defineProperty(window, "readerPageUrlCount", {
      get: () => urls.size,
    });
  });
  const { book } = await openSample(page, "Page cache", await samplePdf(0, 40));
  const frame = page
    .frames()
    .find((frame) => frame.url().includes("bookreader-frame.html"))!;
  for (const index of [5, 10, 15, 20, 25, 30, 35, 0]) {
    await expect(book.locator(".br-mode-2up__leafs--flipping")).toHaveCount(0);
    await page.evaluate(
      (index) =>
        document
          .querySelector<HTMLIFrameElement>("iframe.pdf-book-frame")!
          .contentWindow!.postMessage(
            { source: "drevo-bookreader", type: "jump", page: index },
            location.origin,
          ),
      index,
    );
    await expect
      .poll(() =>
        book
          .locator(`.BRpage-visible[data-index="${index}"] img.BRpageimage`)
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
  }
  expect(
    await frame.evaluate(
      () =>
        (window as unknown as { readerPageUrlCount: number })
          .readerPageUrlCount,
    ),
  ).toBeLessThanOrEqual(24);
});
