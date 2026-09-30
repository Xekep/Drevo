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

test("PDF без привязки остаётся в общем каталоге", async ({
  page,
}, testInfo) => {
  const title = `Неизвестная метрическая запись ${testInfo.project.name}`;
  await page.goto("/documents");
  await page.getByRole("button", { name: "Добавить PDF" }).click();
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
  await expect(reader).toBeVisible();
  await expect(page).toHaveURL(/\/documents\/[a-f0-9-]{36}$/);
  const documentUrl = page.url();
  const documentId = new URL(documentUrl).pathname.split("/").at(-1);
  await page.goto(`/documents?documentId=${documentId}`);
  await expect(page).toHaveURL(documentUrl);
  await expect(reader).toBeVisible();
  await page.reload();
  await expect(reader).toBeVisible();
  await reader.getByText("Сведения о документе").click();
  await expect(reader.getByText("ГАСО Ф.6 Оп.13 Д.104")).toBeVisible();
  await reader
    .getByRole("button", { name: "Редактировать сведения о документе" })
    .click();
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
  await reader.getByText("Сведения о документе").click();
  await expect(reader.getByText("ГАСО Ф.6 Оп.13 Д.105")).toBeVisible();
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

test("источник карточки связывается с PDF без копирования файла", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  const title = `Свидетельство для источника ${Date.now()}`;
  const uploaded = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: ["e2e-child"] }),
      ),
    },
    data: await samplePdf(1),
  });
  expect(uploaded.status()).toBe(201);
  const { id } = (await uploaded.json()) as { id: string };
  await page.goto("/people/e2e-child");
  await page.getByRole("button", { name: "Изменить человека" }).click();
  await page.locator(".form-details > summary").filter({ hasText: "Источники" }).click();
  await page.getByRole("button", { name: "+ Источник" }).click();
  const source = page.locator(".source-editor").last();
  await source.getByRole("button", { name: "Связать с PDF" }).click();
  await source.getByLabel("Найти PDF человека").fill(title);
  await source.getByRole("button", { name: title, exact: true }).click();
  await expect(source.getByRole("link", { name: "Открыть связанный PDF" })).toHaveAttribute(
    "href",
    `/documents/${id}`,
  );
  await page.locator(".event-editor > summary").click();
  await page.getByRole("button", { name: "Добавить событие" }).click();
  const event = page.locator(".life-event-editor").last();
  await event.locator(".event-extra > summary").click();
  await event.getByRole("button", { name: "Добавить источник" }).click();
  const eventSource = event.locator(".event-source-editor").last();
  await eventSource.getByRole("button", { name: "Связать с PDF" }).click();
  await eventSource.getByLabel("Найти PDF человека").fill(title);
  await eventSource.getByRole("button", { name: title, exact: true }).click();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  await page.locator(".life-event").last().locator(".event-sources > summary").click();
  await expect(
    page.locator(".life-event").last().getByRole("link", { name: "Открыть PDF" }),
  ).toHaveAttribute("href", `/documents/${id}`);
  await page.getByRole("tab", { name: /Источники/ }).click();
  const card = page.locator(".source-card").filter({ hasText: title });
  await expect(card.getByRole("link", { name: "Открыть PDF" })).toHaveAttribute(
    "href",
    `/documents/${id}`,
  );
  const unlinkBlocked = await page.request.patch(`/api/documents/${id}`, {
    data: { people: { expected: ["e2e-child"], next: [] } },
  });
  expect(unlinkBlocked.status()).toBe(409);
  const blocked = await page.request.delete(`/api/documents/${id}`);
  expect(blocked.status()).toBe(409);
  await page.goto(`/documents/${id}`);
  await expect(page.getByRole("dialog", { name: `Документ: ${title}` })).toBeVisible();
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
  await expect(page.getByText("Перетащите PDF сюда")).toBeVisible();
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
  await reader.getByText("Сведения о документе").click();
  await reader
    .getByRole("button", { name: "Редактировать сведения о документе" })
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
    .getByRole("button", { name: "Привязать PDF из каталога" })
    .click();
  await documents.getByLabel("Найти PDF").fill(title);
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
    data.items.add(new File(["image"], "image.png", { type: "image/png" }));
    return data;
  });
  await page.locator("body").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Можно загрузить только PDF-файл" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Добавить документ" }),
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
    .getByRole("link", { name: "Открыть документ" });
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
  await page.getByRole("button", { name: "Закрыть документ" }).click();
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

test("участник загружает PDF и читает страницы без анимации", async ({
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
  const newReader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await expect(newReader).toBeVisible();
  await expect(
    newReader.getByRole("button", { name: "Отменить выделение" }),
  ).toBeVisible();
  await newReader.getByRole("button", { name: "Закрыть документ" }).click();
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
  await expect(
    reader.getByRole("link", { name: "Скачать оригинал" }),
  ).toBeVisible();
  await reader.getByRole("button", { name: "Оглавление" }).click();
  await reader
    .getByRole("navigation", { name: "Оглавление документа" })
    .getByRole("button", { name: /Вторая страница/ })
    .click();
  await expect(reader.getByText("2 из 3")).toBeVisible();
  await reader.getByRole("button", { name: "Предыдущая страница" }).click();
  await reader.getByRole("button", { name: "Лупа" }).click();
  await firstPage.hover();
  await expect(
    reader.locator('.pdf-reader-sheet > div[style*="border-radius: 50%"]'),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reader.getByRole("button", { name: "Лупа" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
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
    await reader.getByRole("button", { name: "Закрыть документ" }).click();
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

test("фрагмент PDF сохраняет комментарий и ссылка перелистывает к нему", async ({
  page,
}, info) => {
  const title = `Комментарий к PDF ${info.project.name}`;
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
  await expect(reader.getByText("1 из 7")).toBeVisible();
  if (info.project.name === "mobile")
    await reader
      .getByRole("button", { name: "Комментарии", exact: true })
      .click();
  await reader.getByRole("button", { name: "Выделить фрагмент" }).click();
  const overlay = reader.locator('[data-page="0"] .pdf-book-overlay').first();
  await expect
    .poll(async () =>
      overlay.evaluate((node) => node.getBoundingClientRect().width),
    )
    .toBeGreaterThan(100);
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.42, {
    steps: 5,
  });
  await page.mouse.up();
  await reader
    .getByRole("textbox", { name: "Комментарий к фрагменту" })
    .fill("Первый фрагмент записи");
  await reader.getByRole("button", { name: "Сохранить комментарий" }).click();
  await expect(reader.getByText("Первый фрагмент записи")).toBeVisible();
  await expect(
    reader.locator('[data-page="0"] .pdf-book-highlight'),
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
  await reader.getByRole("button", { name: "Закрыть документ" }).click();
  await page.locator(".document-item").filter({ hasText: title }).click();
  if (info.project.name === "mobile")
    await reader
      .getByRole("button", { name: "Комментарии", exact: true })
      .click();
  await reader
    .getByRole("button", { name: /Страница 7.*Последняя страница/ })
    .click();
  await expect(
    reader.locator('[data-page="6"] .pdf-book-highlight.is-active'),
  ).toHaveCount(1, { timeout: 15000 });
  await expect
    .poll(async () => {
      const area = await reader
        .locator('[data-page="6"] .pdf-book-overlay')
        .boundingBox();
      const mark = await reader
        .locator('[data-page="6"] .pdf-book-highlight.is-active')
        .boundingBox();
      if (!area || !mark || area.width < 100) return Infinity;
      return Math.max(
        Math.abs(mark.x - area.x - area.width * 0.2),
        Math.abs(mark.y - area.y - area.height * 0.3),
        Math.abs(mark.width - area.width * 0.3),
        Math.abs(mark.height - area.height * 0.2),
      );
    })
    .toBeLessThan(4);
  await expect(reader.locator(".pdf-book-footer")).toContainText("7 из 7");
  await reader.screenshot({ path: info.outputPath("pdf-annotations.png") });
  await reader.getByRole("button", { name: "Закрыть документ" }).click();
  await page.goto("/documents");
  await page.locator(".document-item").filter({ hasText: title }).click();
  if (info.project.name === "mobile")
    await reader
      .getByRole("button", { name: "Комментарии", exact: true })
      .click();
  await expect(reader.getByText("Первый фрагмент записи")).toBeVisible();
});

test("книга открывает PDF длиннее 300 страниц", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
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
  await expect(
    page
      .getByRole("dialog", { name: `Документ: ${title}` })
      .getByText("1 из 301"),
  ).toBeVisible({ timeout: 20000 });
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await reader
    .getByRole("button", { name: /Страница 301.*Запись в конце/ })
    .click();
  await expect(
    reader.locator('[data-page="300"] .pdf-book-highlight.is-active'),
  ).toHaveCount(1, { timeout: 15000 });
  await expect
    .poll(() =>
      reader
        .locator('[data-page="300"] img')
        .first()
        .evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
});
