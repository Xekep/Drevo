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

test("PDF без привязки остаётся в общем каталоге", async ({ page }, testInfo) => {
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
  await expect(form.getByRole("button", { name: "Добавить документ" })).toBeEnabled();
  await form.getByRole("button", { name: "Добавить документ" }).click();
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  await expect(reader).toBeVisible();
  await reader.getByText("Сведения о документе").click();
  await expect(reader.getByText("ГАСО Ф.6 Оп.13 Д.104")).toBeVisible();
  await reader.getByRole("button", { name: "Редактировать сведения о документе" }).click();
  const edit = page.getByRole("form", { name: "Редактировать документ" });
  await expect(edit).toBeVisible();
  await edit.getByLabel("Происхождение").fill("ГАСО Ф.6 Оп.13 Д.105");
  await edit.getByRole("button", { name: "Сохранить" }).click();
  await expect(edit).toBeHidden();
  const group = page.locator(".documents-group").filter({
    has: page.getByRole("heading", { name: "Без привязки" }),
  });
  await expect(group.locator(".document-item").filter({ hasText: title })).toBeVisible();
  await group.locator(".document-item").filter({ hasText: title }).click();
  await reader.getByText("Сведения о документе").click();
  await expect(reader.getByText("ГАСО Ф.6 Оп.13 Д.105")).toBeVisible();
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
  expect(linkedUrl).toMatch(
    /^\/documents\?personId=e2e-child&documentId=[a-f0-9-]{36}$/,
  );
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
  await page.getByRole("button", { name: "Закрыть документ" }).click();
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
