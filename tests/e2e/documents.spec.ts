import { expect, test } from "@playwright/test";
import PDFDocument from "pdfkit";
import sharp from "sharp";
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
  await form.getByLabel("Описание").fill("Запись о рождении");
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
  await book.locator(".BRinfo .floatShut").click();
  await book.getByRole("button", { name: "Редактировать сведения" }).click();
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

test("скан изображения открывается в ридере и по постоянной ссылке", async ({
  page,
}, testInfo) => {
  const title = `Скан документа ${testInfo.project.name} ${Date.now()}`;
  const scan = await sharp({ create: {
    width: 360, height: 480, channels: 3, background: "#e2decf",
  } }).png().toBuffer();
  await page.goto("/documents");
  await page.getByRole("button", { name: "Добавить документ" }).click();
  const form = page.locator(".documents-upload");
  await form.locator('input[type="file"]').setInputFiles({
    name: "scan.png", mimeType: "image/png", buffer: scan,
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
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]{36}$/);
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(book.locator('.BRpage-visible[data-index="0"] img.BRpageimage'))
    .toBeVisible();
});

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
    .filter({ hasText: "Источники" })
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
  await event.getByRole("button", { name: "Добавить источник" }).click();
  const eventSource = event.locator(".event-source-editor").last();
  await eventSource.getByRole("button", { name: "Связать с документом" }).click();
  await eventSource.getByLabel("Найти документ человека").fill(title);
  await eventSource.getByRole("button", { name: title, exact: true }).click();
  await eventSource.getByRole("spinbutton", { name: "Страница документа" }).fill("2");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page
    .locator(".life-event")
    .last()
    .locator(".event-sources > summary")
    .click();
  await expect(
    page
      .locator(".life-event")
      .last()
      .getByRole("link", { name: "Открыть документ" }),
  ).toHaveAttribute("href", `/documents/${id}/page/2`);
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
    .getByRole("button", { name: "Редактировать сведения" })
    .click();
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
    .filter({ hasText: "Источники" })
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
      .filter({ hasText: "Поддерживаются PDF, JPEG, PNG, WebP и GIF" }),
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
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: `Удалить документ «${title}»` })
      .click();
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
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.42, {
    steps: 5,
  });
  await page.mouse.up();
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
  await book.getByRole("button", { name: "Комментарии" }).click();
  await firstMark.hover();
  await expect(firstMark).not.toHaveClass(/is-hovered/);
  await expect(firstMark).toHaveCSS("background-color", "rgba(233, 194, 97, 0.3)");
  await book.getByRole("button", { name: "Комментарии" }).click();
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
