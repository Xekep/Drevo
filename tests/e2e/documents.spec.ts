import { expect, test } from "@playwright/test";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { readFileSync } from "node:fs";
import { sampleTiff } from "../fixtures/tiff.ts";

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

test("PDF без привязки остаётся в общем каталоге", async ({
  page,
}, testInfo) => {
  const title = `Неизвестная метрическая запись ${testInfo.project.name}`;
  await page.goto("/documents");
  await page.getByRole("button", { name: "Добавить документ" }).click();
  const form = page.locator(".documents-upload");
  await form.locator('input[type="file"]').setInputFiles({
    name: "record.pdf",
    mimeType: "application/pdf",
    buffer: await samplePdf(1),
  });
  await form.getByLabel("Название").fill(title);
  await form.getByText("Сведения о документе").click();
  await form.getByLabel("Тип").fill("Метрическая запись");
  await form.getByLabel("Дата или период").fill("1887 год");
  await form.getByLabel("Место").fill("Реж");
  await form.getByLabel("Происхождение").fill("ГАСО Ф.6 Оп.13 Д.104");
  const description = "Запись о рождении\nВторая строка\n\n**Обычный текст**, <не HTML>";
  await form.getByLabel("Описание").fill(description);
  await expect(
    form.getByRole("button", { name: "Добавить документ" }),
  ).toBeEnabled();
  await form.getByRole("button", { name: "Добавить документ" }).click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  await expect(reader).toBeVisible();
  await expect.poll(async () =>
    (await book.locator(".BRpagecontainer").first().boundingBox())?.width || 0,
  ).toBeGreaterThan(testInfo.project.name === "mobile" ? 190 : 350);
  await expect(reader.locator(".pdf-book-sidebar")).toBeHidden();
  await expect(book.locator("body")).not.toHaveClass(/drevo-annotating/);
  await expect(book.getByRole("button", { name: "Комментарии" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]{36}$/);
  const documentUrl = page.url();
  const documentId = new URL(documentUrl).pathname.split("/").at(-1);
  await page.goto(`/documents?documentId=${documentId}`);
  await expect(page).toHaveURL(documentUrl);
  await expect(reader).toBeVisible();
  await page.reload();
  await expect(reader).toBeVisible();
  await book.locator(".BRtoolbar .info").click();
  await expect(book.locator(".BRinfo")).toContainText("ГАСО Ф.6 Оп.13 Д.104");
  const descriptionValue = book.locator(".BRinfoValueWrapper").filter({ has: book.getByText("Описание", { exact: true }) }).locator(".BRinfoValue");
  await expect(descriptionValue).toHaveCSS("white-space", "pre-wrap");
  expect(await descriptionValue.textContent()).toBe(description);
  await expect(descriptionValue.locator("strong")).toHaveCount(0);
  await expect(book.getByRole("button", { name: "Редактировать сведения" })).toHaveCount(0);
  await book.locator(".BRinfo .floatShut").click();
  await book.getByRole("button", { name: "Закрыть документ" }).click();
  await page.getByRole("button", { name: `Редактировать документ «${title}»` }).click();
  const edit = page.getByRole("form", { name: "Редактировать документ" });
  await expect(edit).toBeVisible();
  await edit.getByLabel("Происхождение").fill("ГАСО Ф.6 Оп.13 Д.105");
  await edit.getByRole("button", { name: "Сохранить" }).click();
  await expect(edit).toBeHidden();
  const group = page.locator(".documents-group").filter({
    has: page.getByRole("heading", { name: "Без привязки" }),
  });
  await expect(
    group.locator(".document-item").filter({ hasText: title }),
  ).toBeVisible();
  await group.locator(".document-item").filter({ hasText: title }).click();
  await expect(page).toHaveURL(documentUrl);
  await book.locator(".BRtoolbar .info").click();
  await expect(book.locator(".BRinfo")).toContainText("ГАСО Ф.6 Оп.13 Д.105");
});

for (const format of ["png", "jpeg", "jfif", "tiff"] as const) {
test(`скан ${format} открывается в ридере и по постоянной ссылке`, async ({
  page,
}, testInfo) => {
  const title = `Скан ${format} ${testInfo.project.name} ${Date.now()}`;
  const codec = format === "jfif" ? "jpeg" : format;
  let scan = codec === "tiff" ? await sampleTiff(360, 480) : await sharp({ create: {
    width: 360, height: 480, channels: 3, background: "#e2decf",
  } })[codec]().toBuffer();
  if (format === "jfif") {
    // JPEG APP0 JFIF header: version 1.01, no thumbnail, density 1x1.
    scan = Buffer.concat([scan.subarray(0, 2), Buffer.from("ffe000104a46494600010100000100010000", "hex"), scan.subarray(2)]);
  }
  await page.goto("/documents");
  await page.getByRole("button", { name: "Добавить документ" }).click();
  const form = page.locator(".documents-upload");
  await form.locator('input[type="file"]').setInputFiles({
    name: `scan.${format}`, mimeType: `image/${codec}`, buffer: scan,
  });
  await form.getByLabel("Название").fill(title);
  await form.getByRole("button", { name: "Добавить документ" }).click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  await expect(reader).toBeVisible();
  const image = book.locator('.BRpage-visible[data-index="0"] img.BRpageimage');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBe(360);
  await expect(reader.locator(".pdf-book-sidebar")).toBeHidden();
  await expect(book.locator("body")).not.toHaveClass(/drevo-annotating/);
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]{36}$/);
  const url = page.url();
  await expect(book.getByRole("button", { name: "Лупа" })).toBeVisible();
  await expect(book.getByRole("searchbox", { name: "Поиск в документе" })).toHaveCount(0);
  const downloadPromise = page.waitForEvent("download");
  await book.getByRole("link", { name: "Скачать оригинал" }).click();
  const download = await downloadPromise;
  expect(readFileSync((await download.path())!)).toEqual(scan);
  if (format === "tiff") {
    await page.goto(`${url}/page/3`);
    const last = book.locator('.BRpage-visible[data-index="2"] img.BRpageimage');
    await expect(last).toBeVisible();
    await expect.poll(() => last.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(360);
    const pixels = await last.evaluate(async (node: HTMLImageElement) => {
      await node.decode();
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.drawImage(node, 0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data];
    });
    expect(pixels[2]).toBeGreaterThan(245);
    expect(pixels[0]).toBeLessThan(10);
    const documentId = new URL(url).pathname.split("/").at(-1);
    const note = await page.request.post(`/api/documents/${documentId}/annotations`, {
      data: { page: 3, x: 0.1, y: 0.2, width: 0.4, height: 0.1, text: "Третья страница TIFF" },
    });
    expect(note.status()).toBe(201);
    await page.reload();
    await book.getByRole("button", { name: "Комментарии" }).click();
    await expect(reader.locator(".pdf-book-sidebar")).toContainText("Третья страница TIFF");
    await page.goto(url);
  }
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(book.locator('.BRpage-visible[data-index="0"] img.BRpageimage'))
    .toBeVisible();
});
}

for (const scan of [
  { format: "png", width: 800, height: 4800 },
  { format: "jpeg", width: 4800, height: 800 },
  { format: "webp", width: 3000, height: 3000 },
  { format: "gif", width: 180, height: 240 },
] as const) {
  test(`скан ${scan.format} целиком помещается при открытии без ручного зума`, async ({ page }, info) => {
    const title = `Fit ${scan.format} ${info.project.name} ${info.retry}`;
    const buffer = await sharp({ create: {
      width: scan.width, height: scan.height, channels: 3, background: "#e2decf",
    } })[scan.format]().toBuffer();
    const upload = await page.request.post("/api/documents", {
      headers: {
        "Content-Type": `image/${scan.format}`,
        "X-Document-Metadata": encodeURIComponent(JSON.stringify({ title, personIds: [] })),
      },
      data: buffer,
    });
    expect(upload.status()).toBe(201);
    const { id } = await upload.json();
    await page.goto(`/documents/${id}`);
    const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
    const book = reader.frameLocator("iframe.pdf-book-frame");
    const image = book.locator('.BRpage-visible[data-index="0"] img.BRpageimage');
    await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(scan.width);
    const checkFit = async () => {
      const bounds = await image.evaluate((node) => {
        const page = node.getBoundingClientRect();
        const viewport = node.closest("br-mode-1up")!.getBoundingClientRect();
        const footer = node.ownerDocument.querySelector(".BRfooter")?.getBoundingClientRect();
        const bottom = Math.min(viewport.bottom, footer?.height ? footer.top : viewport.bottom);
        return {
          fits: page.left >= viewport.left - 1 && page.top >= viewport.top - 1 &&
            page.right <= viewport.right + 1 && page.bottom <= bottom + 1,
          fill: Math.max(page.width / viewport.width, page.height / (bottom - viewport.top)),
          ratio: page.width / page.height,
          page: { left: page.left, top: page.top, right: page.right, bottom: page.bottom },
          viewport: { left: viewport.left, top: viewport.top, right: viewport.right, bottom },
        };
      });
      expect(bounds.fits, JSON.stringify(bounds)).toBe(true);
      expect(bounds.fill, JSON.stringify(bounds)).toBeGreaterThan(0.75);
      expect(bounds.ratio).toBeCloseTo(scan.width / scan.height, 3);
    };
    await expect(async () => checkFit()).toPass();
    if (scan.format === "png")
      await reader.screenshot({ path: info.outputPath("tall-scan-fit.png") });
    const initialViewport = page.viewportSize()!;
    await page.setViewportSize({ width: initialViewport.height, height: initialViewport.width });
    await expect(async () => checkFit()).toPass();
    await page.setViewportSize(initialViewport);
    await expect(async () => checkFit()).toPass();
    await book.locator(".BRicon.full:visible").first().click();
    await expect(async () => checkFit()).toPass();
    await book.locator(".BRicon.full:visible").first().click();
    await expect(async () => checkFit()).toPass();
    if (info.project.name === "desktop") {
      const originalWidth = (await image.boundingBox())!.width;
      await book.locator(".BRicon.zoom_in:visible").first().click();
      await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(originalWidth * 1.05);
      const zoomedWidth = (await image.boundingBox())!.width;
      await page.setViewportSize({ ...initialViewport, height: initialViewport.height - 120 });
      await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(zoomedWidth, 1);
      await page.setViewportSize(initialViewport);
      await book.locator(".BRicon.zoom_out:visible").first().click();
      await expect(async () => checkFit()).toPass();
    }
    await page.reload();
    await expect(image).toBeVisible();
    await expect(async () => checkFit()).toPass();
  });
}

test("верхний поиск находит PDF и открывает постоянную ссылку", async ({
  page,
}, testInfo) => {
  const title = `Поисковый документ ${testInfo.project.name} ${Date.now()}`;
  const uploaded = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: [] }),
      ),
    },
    data: await samplePdf(1),
  });
  expect(uploaded.status()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  await page.goto("/documents");
  await page
    .getByRole("combobox", { name: "Найти человека или документ" })
    .fill(title);
  await page.getByRole("option", { name: new RegExp(title) }).click();
  await expect(page).toHaveURL(new RegExp(`/documents/${id}$`));
  await expect(
    page.getByRole("dialog", { name: `Документ: ${title}` }),
  ).toBeVisible();
});

test("источник карточки связывается с PDF без копирования файла", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const title = `Свидетельство для источника ${Date.now()}`;
  const uploaded = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: ["e2e-child"] }),
      ),
    },
    data: await samplePdf(3),
  });
  expect(uploaded.status()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  await page.goto("/people/e2e-child");
  await page.getByRole("button", { name: "Изменить человека" }).click();
  await page
    .locator(".form-details > summary")
    .filter({ hasText: /^Источники$/ })
    .click();
  await page.getByRole("button", { name: "+ Источник" }).click();
  const source = page.locator(".source-editor").last();
  await source.getByRole("button", { name: "Связать с документом" }).click();
  await source.getByLabel("Найти документ человека").fill(title);
  await source.getByRole("button", { name: title, exact: true }).click();
  await source.getByRole("spinbutton", { name: "Страница документа" }).fill("2");
  await expect(
    source.getByRole("link", { name: "Открыть связанный документ" }),
  ).toHaveAttribute("href", `/documents/${id}/page/2`);
  await page.locator(".event-editor > summary").click();
  await page.getByRole("button", { name: "Добавить событие" }).click();
  const event = page.locator(".life-event-editor").last();
  await event.locator(".event-extra > summary").click();
  await expect(event.getByRole("button", { name: "Добавить источник" })).toHaveCount(0);
  await event.getByLabel("Дата", { exact: true }).fill("1991");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".life-event").last()).toContainText("1991");
  await page.getByRole("tab", { name: /Источники/ }).click();
  const card = page.locator(".source-card").filter({ hasText: title });
  await expect(card.getByRole("link", { name: "Открыть документ" })).toHaveAttribute(
    "href",
    `/documents/${id}/page/2`,
  );
  const unlinkBlocked = await page.request.patch(`/api/documents/${id}`, {
    data: { people: { expected: ["e2e-child"], next: [] } },
  });
  expect(unlinkBlocked.status()).toBe(409);
  const blocked = await page.request.delete(`/api/documents/${id}`);
  expect(blocked.status()).toBe(409);
  await page.goto(`/documents/${id}/page/2`);
  await expect(
    page.getByRole("dialog", { name: `Документ: ${title}` }),
  ).toBeVisible();
  await expect(
    page.frameLocator("iframe.pdf-book-frame").locator(".BRcurrentpage"),
  ).toContainText("Page 2");
  await page.goto(`/documents/${id}/page/2000`);
  await expect(
    page
      .frameLocator("iframe.pdf-book-frame")
      .locator('.BRpage-visible[data-index="2"]'),
  ).toBeVisible();
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
    if (index === 2) pdf.outline.addItem("Вторая страница");
  }
  pdf.end();
  return done;
}

test("PDF можно перетащить, затем привязать из документа и редактора человека", async ({
  page,
}, testInfo) => {
  const title = `Перетащенный PDF ${testInfo.project.name}`;
  await page.goto("/documents");
  await expect(page.locator(".documents-add")).toBeVisible();
  const transfer = await page.evaluateHandle(
    (bytes) => {
      const data = new DataTransfer();
      data.items.add(
        new File([new Uint8Array(bytes)], "record.pdf", {
          type: "application/pdf",
        }),
      );
      return data;
    },
    [...(await samplePdf(1))],
  );
  await page
    .locator("body")
    .dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(page.getByText("Перетащите документ сюда")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("documents-drop.png") });
  await page.locator("body").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.locator(".documents-drop-overlay")).toHaveCount(0);
  const form = page.locator(".documents-upload");
  await expect(form.getByText("record.pdf", { exact: true })).toBeVisible();
  await form.getByLabel("Название").fill(title);
  await form.getByRole("button", { name: "Добавить документ" }).click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await expect(reader).toBeVisible();
  const id = new URL(page.url()).pathname.split("/").at(-1);
  await reader
    .frameLocator("iframe.pdf-book-frame")
    .getByRole("button", { name: "Закрыть документ" })
    .click();
  await page.getByRole("button", { name: `Редактировать документ «${title}»` }).click();
  const edit = page.getByRole("form", { name: "Редактировать документ" });
  await edit.getByLabel("Найти человека для документа").fill("Пётр");
  await edit
    .locator(".documents-person-results")
    .getByRole("button", { name: /Пётр/ })
    .click();
  await edit.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(edit).toBeHidden();
  expect(
    (await (await page.request.get(`/api/documents/${id}`)).json()).people.map(
      (person: { id: string }) => person.id,
    ),
  ).toEqual(["e2e-child"]);

  await page.goto("/people/e2e-spouse");
  await page.getByRole("button", { name: "Изменить человека" }).click();
  await page
    .locator(".form-details > summary")
    .filter({ hasText: /^Источники$/ })
    .click();
  const documents = page.getByRole("region", { name: "Документы человека" });
  await documents
    .getByRole("button", { name: "Привязать документ из каталога" })
    .click();
  await documents.getByLabel("Найти документ").fill(title);
  await documents
    .locator(".person-document-picker .person-document-row")
    .filter({ hasText: title })
    .getByRole("button", { name: "Привязать", exact: true })
    .click();
  const unlink = documents.getByRole("button", {
    name: `Отвязать ${title}`,
    exact: true,
  });
  await expect(unlink).toBeVisible();
  await expect(unlink).toBeEnabled();
  await page.screenshot({ path: testInfo.outputPath("person-documents.png") });
  expect(
    (await (await page.request.get(`/api/documents/${id}`)).json()).people
      .map((person: { id: string }) => person.id)
      .sort(),
  ).toEqual(["e2e-child", "e2e-spouse"]);
  await unlink.click();
  await expect(unlink).toHaveCount(0);
  expect(
    (await (await page.request.get(`/api/documents/${id}`)).json()).people.map(
      (person: { id: string }) => person.id,
    ),
  ).toEqual(["e2e-child"]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
});

test("каталог документов отклоняет перетаскивание файлов других форматов", async ({
  page,
}) => {
  await page.goto("/documents");
  await expect(page.locator(".documents-add")).toBeVisible();
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(["<svg/>"], "unsafe.svg", { type: "image/svg+xml" }));
    return data;
  });
  await page.locator("body").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Поддерживаются PDF, TIFF, JPEG/JFIF, PNG, WebP и GIF" }),
  ).toBeVisible();
  await expect(
    page.locator(".documents-upload-submit"),
  ).toBeDisabled();
});

test("из карточки человека открываются только его PDF-документы", async ({
  page,
}, testInfo) => {
  const title = `Документ ребёнка ${testInfo.project.name}`;
  const secondTitle = `Метрическая выписка ребёнка ${testInfo.project.name}`;
  const otherTitle = `Документ супруга ${testInfo.project.name}`;
  for (const [name, personId] of [
    [title, "e2e-child"],
    [secondTitle, "e2e-child"],
    [otherTitle, "e2e-spouse"],
  ]) {
    const response = await page.request.post("/api/documents", {
      headers: {
        "Content-Type": "application/pdf",
        "X-Document-Metadata": encodeURIComponent(
          JSON.stringify({ title: name, personIds: [personId] }),
        ),
      },
      data: await samplePdf(1),
    });
    expect(response.status()).toBe(201);
  }
  await page.goto("/people/e2e-child");
  const panel = page.locator(".inspector-dock");
  // Desktop and mobile workers may upload to the same fixture database.
  await expect
    .poll(async () =>
      Number(
        await panel
          .getByRole("tab", { name: /Источники/ })
          .locator(".count-badge")
          .textContent(),
      ),
    )
    .toBeGreaterThanOrEqual(2);
  await panel.getByRole("tab", { name: /Источники/ }).click();
  await expect(
    panel.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(panel.getByRole("heading", { name: secondTitle })).toBeVisible();
  await expect(panel.getByRole("heading", { name: otherTitle })).toHaveCount(0);
  const documentLink = panel
    .getByRole("heading", { name: title, exact: true })
    .locator("..")
    .getByRole("link", { name: "Открыть файл" });
  const linkedUrl = await documentLink.getAttribute("href");
  expect(linkedUrl).toMatch(/^\/documents\/person\/e2e-child\/[a-f0-9-]{36}$/);
  await documentLink.click();
  await expect(page).toHaveURL(linkedUrl!);
  await expect(
    page.getByRole("dialog", { name: `Документ: ${title}` }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("dialog", { name: `Документ: ${title}` }),
  ).toBeVisible();
  await page
    .frameLocator("iframe.pdf-book-frame")
    .getByRole("button", { name: "Закрыть документ" })
    .click();
  await expect(page).toHaveURL(/\/documents\/person\/e2e-child$/);
  await expect(
    page.locator(".document-item").filter({ hasText: title }),
  ).toBeVisible();
  await expect(
    page.locator(".document-item").filter({ hasText: otherTitle }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Показать все документы" }).click();
  await expect(
    page.locator(".document-item").filter({ hasText: otherTitle }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/documents\/person\/e2e-child$/);
  await expect(
    page.getByRole("dialog", { name: `Документ: ${title}` }),
  ).toHaveCount(0);
  await expect(
    page.locator(".document-item").filter({ hasText: otherTitle }),
  ).toHaveCount(0);
  if (testInfo.project.name === "mobile")
    await page.getByLabel("Меню проекта").click();
  await page
    .locator(
      testInfo.project.name === "mobile" ? ".mobile-sections" : ".nav-sections",
    )
    .getByRole("link", { name: "Документы" })
    .click();
  await expect(
    page.locator(".document-item").filter({ hasText: otherTitle }),
  ).toBeVisible();
});

test("участник загружает PDF и читает страницы с перелистыванием", async ({
  page,
}, testInfo) => {
  const title = `Архивный документ ${testInfo.project.name}`;
  await page.goto("/documents");
  await expect(page.getByRole("heading", { name: "Документы" })).toBeVisible();
  await page.getByRole("button", { name: "Добавить документ" }).click();
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
  const newReader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await expect(newReader).toBeVisible();
  const newBook = newReader.frameLocator("iframe.pdf-book-frame");
  await expect(newReader.locator(".pdf-book-sidebar")).toBeHidden();
  await expect(newBook.locator("body")).not.toHaveClass(/drevo-annotating/);
  await newBook.getByRole("button", { name: "Комментарии" }).click();
  await expect(
    newReader.getByRole("button", { name: "Выделить фрагмент" }),
  ).toBeVisible();
  await newReader.getByRole("button", { name: "Выделить фрагмент" }).click();
  await expect(newBook.locator("body")).toHaveClass(/drevo-annotating/);
  await newBook.getByRole("button", { name: "Комментарии" }).click();
  await expect(
    newReader.getByRole("button", { name: "Отменить выделение" }),
  ).toBeVisible();
  await newReader
    .frameLocator("iframe.pdf-book-frame")
    .getByRole("button", { name: "Закрыть документ" })
    .click();
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
  const book = reader.frameLocator("iframe.pdf-book-frame");
  await expect(book.locator(".BRfooter")).toBeVisible();
  const firstPage = book.locator(
    '.BRpage-visible[data-index="0"] img.BRpageimage',
  );
  await expect
    .poll(() =>
      firstPage.evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(
    book.getByRole("link", { name: "Скачать оригинал" }),
  ).toBeVisible();
  await book.getByRole("button", { name: "Комментарии" }).click();
  await reader.locator(".pdf-book-sidebar-tabs button").last().click();
  await reader.locator(".pdf-book-outline button").first().click();
  await expect(book.locator('.BRpage-visible[data-index="1"]')).toBeVisible();
  await book.getByRole("button", { name: "Лупа" }).click();
  await expect(book.locator("body.drevo-magnifying")).toHaveCount(1);
  await book.locator("body").press("Escape");
  await expect(book.locator("body.drevo-magnifying")).toHaveCount(0);
  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 600 });
    await expect(book.locator('.BRpage-visible[data-index="1"]')).toBeVisible();
  }
  await book.getByRole("button", { name: "Закрыть документ" }).click();
  await expect(reader).toBeHidden();
  await page
    .getByRole("button", { name: `Удалить документ «${title}»`, exact: true })
    .click();
  await page.getByRole("button", { name: `Подтвердить удаление документа «${title}»`, exact: true }).click();
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
      const book = reader.frameLocator("iframe.pdf-book-frame");
      const image = book
        .locator('.BRpage-visible[data-index="0"] img.BRpageimage')
        .first();
      await expect
        .poll(() =>
          image.evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBeGreaterThan(0);
      const rect = await image.boundingBox();
      expect(rect!.width).toBeGreaterThan(100);
      expect(rect!.height).toBeGreaterThan(100);
      if (variant === "landscape")
        expect(rect!.width / rect!.height).toBeGreaterThan(1.2);
      else
        await expect(
          reader.locator(".pdf-book-sidebar-tabs button"),
        ).toHaveCount(1);
    }
    if (variant === "damaged")
      await reader.getByRole("button", { name: "Закрыть документ" }).click();
    else
      await reader
        .frameLocator("iframe.pdf-book-frame")
        .getByRole("button", { name: "Закрыть документ" })
        .click();
    await page
      .getByRole("button", { name: `Удалить документ «${title}»` })
      .click();
    await page.getByRole("button", { name: `Подтвердить удаление документа «${title}»` }).click();
    await expect(reader).toBeHidden();
    expect((await page.request.get(`/api/documents/${id}/file`)).status()).toBe(
      404,
    );
  });
}

test("PDF comments remain attached to their pages", async ({ page }, info) => {
  const title = `PDF comments ${info.project.name}`;
  const uploaded = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: ["e2e-child"] }),
      ),
    },
    data: await samplePdf(7),
  });
  expect(uploaded.status()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  await page.goto("/documents");
  await page.locator(".document-item").filter({ hasText: title }).click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible();
  await book.getByRole("button", { name: "Комментарии" }).click();
  await reader.locator(".pdf-book-add-comment").click();
  const overlay = book
    .locator('.BRpage-visible[data-index="0"] .drevo-page-layer')
    .first();
  await expect(book.locator("body")).toHaveClass(/drevo-annotating/);
  await overlay.hover();
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.42, {
    steps: 5,
  });
  const draft = book.locator('.BRpage-visible[data-index="0"] .drevo-page-draft').first();
  await expect(draft).toBeVisible();
  await expect(draft).toHaveCSS("border-style", "dashed");
  await expect(draft).toHaveCSS("border-width", "2px");
  await expect.poll(async () => (await draft.boundingBox())?.width || 0).toBeGreaterThan(box.width * 0.2);
  await overlay.dispatchEvent("pointercancel", { pointerId: 1 });
  await page.mouse.up();
  await expect(draft).toBeHidden();
  await expect(reader.locator(".pdf-book-comment-form")).toBeHidden();
  // Selecting in the opposite direction produces the same normalized rectangle.
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.42);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3, { steps: 5 });
  await expect(draft).toBeVisible();
  await page.screenshot({ path: info.outputPath("comment-live-draft.png") });
  await page.mouse.up();
  await expect(draft).toBeVisible();
  await reader
    .locator(".pdf-book-comment-form textarea")
    .fill("Первый фрагмент записи");
  await reader.locator(".pdf-book-comment-form button").first().click();
  await expect(reader.getByText("Первый фрагмент записи")).toBeVisible();
  await expect(
    book.locator('.BRpage-visible[data-index="0"] .drevo-page-mark'),
  ).toHaveCount(1);
  const second = await page.request.post(`/api/documents/${id}/annotations`, {
    data: {
      page: 7,
      x: 0.2,
      y: 0.3,
      width: 0.3,
      height: 0.2,
      text: "Последняя страница",
    },
  });
  expect(second.status()).toBe(201);
  await book.getByRole("button", { name: "Закрыть документ" }).click();
  await page.locator(".document-item").filter({ hasText: title }).click();
  await book.getByRole("button", { name: "Комментарии" }).click();
  const firstMark = book.locator('.BRpage-visible[data-index="0"] .drevo-page-mark').first();
  await expect(firstMark).toHaveCSS("background-color", "rgba(233, 194, 97, 0.1)");
  const firstComment = reader.locator(".pdf-book-comments-list article").filter({
    hasText: "Первый фрагмент записи",
  });
  await firstComment.hover();
  await expect(firstMark).toHaveClass(/is-hovered/);
  await expect(firstMark).toHaveCSS("background-color", "rgba(233, 194, 97, 0.3)");
  await reader.getByRole("button", { name: "Закрыть панель комментариев" }).click();
  await firstMark.hover();
  await expect(firstMark).not.toHaveClass(/is-hovered/);
  await expect(firstMark).toHaveCSS("background-color", "rgba(233, 194, 97, 0.3)");
  await firstMark.click();
  await expect(reader.locator(".pdf-book-sidebar")).toBeVisible();
  await expect(firstComment).toHaveClass("is-active");
  await expect(firstMark).toHaveAttribute("aria-pressed", "true");
  await reader.getByRole("button", { name: "Закрыть панель комментариев" }).click();
  await firstMark.focus();
  await firstMark.press("Enter");
  await expect(reader.locator(".pdf-book-sidebar")).toBeVisible();
  await expect(firstComment).toHaveClass("is-active");
  await reader
    .locator(".pdf-book-comments-list article")
    .filter({ hasText: "Последняя страница" })
    .locator("button")
    .first()
    .click();
  await expect(
    book.locator('.BRpage-visible[data-index="6"] .drevo-page-mark.is-active'),
  ).toHaveCount(1);
  await expect
    .poll(() =>
      book
        .locator('.BRpage-visible[data-index="6"] img.BRpageimage')
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await book.getByRole("button", { name: "Закрыть документ" }).click();
  await page.goto("/documents");
  await page.locator(".document-item").filter({ hasText: title }).click();
  await book.getByRole("button", { name: "Комментарии" }).click();
  await expect(reader.getByText("Первый фрагмент записи")).toBeVisible();
});

test("clicking a document mark opens comments, selects its entry and scrolls past other comments", async ({ page }, info) => {
  const title = `Comment mark navigation ${info.project.name}`;
  const uploaded = await page.request.post("/api/documents", {
    headers: { "Content-Type": "application/pdf", "X-Document-Metadata": encodeURIComponent(JSON.stringify({ title, personIds: [] })) },
    data: await samplePdf(3),
  });
  expect(uploaded.status()).toBe(201);
  const { id } = await uploaded.json();
  let targetId = "";
  const targetText = "Нужный комментарий в конце списка";
  for (let index = 0; index < 20; index++) {
    const response = await page.request.post(`/api/documents/${id}/annotations`, {
      data: { page: 1, x: 0.1, y: index === 19 ? 0.75 : 0.1, width: 0.4, height: 0.1,
        text: index === 19 ? targetText : `Комментарий ${index + 1}: сведения об источнике и месте записи. Подробное описание фрагмента архивного документа.` },
    });
    expect(response.status()).toBe(201);
    if (index === 19) targetId = (await response.json()).items.at(-1).id;
  }
  await page.goto(`/documents/${id}`);
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  const mark = book.locator(`.BRpage-visible[data-index="0"] [data-annotation-id="${targetId}"]`).first();
  await expect(mark).toBeVisible();
  await book.getByRole("button", { name: "Комментарии" }).click();
  const outlineTab = reader.locator(".pdf-book-sidebar-tabs").getByRole("button", { name: "Оглавление", exact: true });
  await outlineTab.click();
  await reader.getByRole("button", { name: "Закрыть панель комментариев" }).click();
  await mark.click();
  const target = reader.locator(".pdf-book-comments-list article").filter({ hasText: targetText });
  await expect(reader.locator(".pdf-book-sidebar")).toBeVisible();
  await expect(outlineTab).toHaveAttribute("aria-pressed", "false");
  await expect(target).toHaveClass("is-active");
  await expect(mark).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => target.evaluate(node => {
    const scroll = node.closest(".pdf-book-comments")!;
    const bounds = node.getBoundingClientRect(), viewport = scroll.getBoundingClientRect();
    return scroll.scrollTop > 0 && bounds.top >= viewport.top - 1 && bounds.bottom <= viewport.bottom + 1;
  })).toBe(true);
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible();
  await page.screenshot({ path: info.outputPath("comment-mark-selected.png") });
  await reader.getByRole("button", { name: "Закрыть панель комментариев" }).click();
  await mark.focus();
  await mark.press("Space");
  await expect(reader.locator(".pdf-book-sidebar")).toBeVisible();
  await expect(target).toHaveClass("is-active");
  await expect(mark).toBeFocused();

  // A new fragment must reveal its form, rather than the previously active
  // comment at the bottom of the long list.
  await reader.locator(".pdf-book-add-comment").click();
  await expect(reader.locator(".pdf-book-sidebar")).toBeHidden();
  await expect(book.locator("body")).toHaveClass(/drevo-annotating/);
  const layer = book.locator('.BRpage-visible[data-index="0"] .drevo-page-layer').first();
  const bounds = (await layer.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.2, bounds.y + bounds.height * 0.35);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.45, bounds.y + bounds.height * 0.48, { steps: 5 });
  await page.mouse.up();
  const form = reader.locator(".pdf-book-comment-form");
  await expect(form).toBeVisible();
  await expect.poll(() => form.evaluate((node) => {
    const panel = node.closest(".pdf-book-comments")!;
    const viewport = panel.getBoundingClientRect();
    const field = node.getBoundingClientRect();
    return panel.scrollTop === 0 && field.top >= viewport.top && field.bottom <= viewport.bottom;
  })).toBe(true);
  await form.getByRole("textbox", { name: "Комментарий к фрагменту" }).fill("Новый комментарий");
  await expect(form.getByRole("button", { name: "Сохранить", exact: true })).toBeEnabled();
  await page.screenshot({ path: info.outputPath("comment-form-at-top.png") });
});

test("document comment clicks keep the panel open and text selection does not navigate", async ({ page }, info) => {
  const title = `Comment reading ${info.project.name} ${info.retry}`;
  const upload = await page.request.post("/api/documents", {
    headers: { "Content-Type": "application/pdf", "X-Document-Metadata": encodeURIComponent(JSON.stringify({ title, personIds: [] })) },
    data: await samplePdf(3),
  });
  expect(upload.status()).toBe(201);
  const { id } = await upload.json();
  for (const [number, text] of [
    [1, "Первый комментарий"],
    [3, "Текст комментария можно выделить и скопировать. Подробности архивной записи."],
  ] as const) {
    const response = await page.request.post(`/api/documents/${id}/annotations`, {
      data: { page: number, x: 0.1, y: 0.2, width: 0.3, height: 0.1, text },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto(`/documents/${id}`);
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  const toggle = book.locator(".drevo-toolbar-comments");
  await toggle.click();
  const sidebar = reader.locator(".pdf-book-sidebar");
  const cards = reader.locator(".pdf-book-comments-list article");
  const first = cards.first().locator("button").first();
  const last = cards.last().locator("button").first();
  await first.click();
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  const text = cards.last().locator(".pdf-book-comment-text p").first();
  await expect(text).toHaveCSS("user-select", "text");
  const bounds = await text.evaluate((node) => {
    const range = node.ownerDocument.createRange();
    range.setStart(node.firstChild!, 0);
    range.setEnd(node.firstChild!, "Текст комментария".length);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right, y: box.top + box.height / 2 };
  });
  await page.mouse.move(bounds.left + 0.5, bounds.y);
  await page.mouse.down();
  await page.mouse.move(bounds.right - 0.1, bounds.y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("Текст комментария");
  await expect(sidebar).toBeVisible();
  await expect(last).toHaveAttribute("aria-pressed", "false");
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible();
  await reader.screenshot({ path: info.outputPath("comment-text-selection.png") });
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await last.click();
  await expect(sidebar).toBeVisible();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(last).toHaveAttribute("aria-pressed", "true");
  await expect(book.locator('.BRpage-visible[data-index="2"] .drevo-page-mark.is-active')).toHaveCount(1);
  await first.focus();
  await first.press("Enter");
  await expect(first).toHaveAttribute("aria-pressed", "true");
  await expect(sidebar).toBeVisible();
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible();
  await reader.getByRole("button", { name: "Закрыть панель комментариев" }).click();
  await expect(sidebar).toBeHidden();
});

test("document comments can be edited, canceled and recover from a conflicting tab", async ({ page }, info) => {
  const title = `Comment editing ${info.project.name} ${info.retry}`;
  const upload = await page.request.post("/api/documents", {
    headers: { "Content-Type": "application/pdf", "X-Document-Metadata": encodeURIComponent(JSON.stringify({ title, personIds: [] })) },
    data: await samplePdf(2),
  });
  expect(upload.status()).toBe(201);
  const { id } = await upload.json();
  const path = `/api/documents/${id}/annotations`;
  const created = await page.request.post(path, { data: {
    page: 1, x: 0.1, y: 0.1, width: 0.3, height: 0.1, text: "Original comment",
  } });
  expect(created.status()).toBe(201);
  const original = (await created.json()).items[0];
  await page.goto("/documents");
  const documentCard = page.locator(".document-item").filter({ hasText: title });
  await documentCard.click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible();
  await book.getByRole("button", { name: "Комментарии" }).click();
  const card = reader.locator(".pdf-book-comments-list article").first();
  const edit = card.getByRole("button", { name: "Изменить комментарий на странице 1" });
  const text = card.getByRole("textbox", { name: "Изменить комментарий" });
  await edit.click();
  await expect(text).toBeFocused();
  await text.fill("Canceled draft");
  await card.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(card.getByText("Original comment", { exact: true })).toBeVisible();
  await expect(edit).toBeFocused();
  await edit.click();
  await text.fill("Edited comment");
  await card.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(card.getByText("Edited comment", { exact: true })).toBeVisible();
  await expect(edit).toBeFocused();
  const saved = (await (await page.request.get(path)).json()).items[0];
  expect(saved).toEqual({ ...original, text: "Edited comment" });
  await edit.click();
  await text.fill("My draft from the first tab");
  const secondTab = await page.request.patch(`${path}/${original.id}`, {
    data: { expected: "Edited comment", text: "Changed in another tab" },
  });
  expect(secondTab.status()).toBe(200);
  await card.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(card.getByRole("alert")).toContainText("Комментарий уже изменён");
  await expect(text).toHaveValue("My draft from the first tab");
  await card.screenshot({ path: info.outputPath("comment-edit-conflict.png") });
  await card.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(card.getByText("Changed in another tab", { exact: true })).toBeVisible();
  await edit.click();
  await expect(text).toHaveValue("Changed in another tab");
  await text.press("Escape");
  await expect(reader).toBeVisible();
  await expect(text).toHaveCount(0);
  await expect(edit).toBeFocused();
  await book.getByRole("button", { name: "Закрыть документ" }).click();
  await documentCard.click();
  await book.getByRole("button", { name: "Комментарии" }).click();
  await expect(card.getByText("Changed in another tab", { exact: true })).toBeVisible();
});

test("BookReader opens a document longer than 300 pages", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  test.setTimeout(60_000);
  const title = "Длинный PDF";
  const uploaded = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: ["e2e-child"] }),
      ),
    },
    data: await samplePdf(301),
  });
  expect(uploaded.status()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  expect(
    (
      await page.request.post(`/api/documents/${id}/annotations`, {
        data: {
          page: 301,
          x: 0.2,
          y: 0.3,
          width: 0.3,
          height: 0.2,
          text: "Запись в конце",
        },
      })
    ).status(),
  ).toBe(201);
  await page.goto("/documents");
  await page.locator(".document-item").filter({ hasText: title }).click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeVisible({
    timeout: 30_000,
  });
  await book.getByRole("button", { name: "Комментарии" }).click();
  await reader
    .locator(".pdf-book-comments-list article")
    .filter({ hasText: "Запись в конце" })
    .locator("button")
    .first()
    .click();
  await expect(
    book.locator(
      '.BRpage-visible[data-index="300"] .drevo-page-mark.is-active',
    ),
  ).toHaveCount(1, { timeout: 15_000 });
  await expect
    .poll(() =>
      book
        .locator('.BRpage-visible[data-index="300"] img.BRpageimage')
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
});
