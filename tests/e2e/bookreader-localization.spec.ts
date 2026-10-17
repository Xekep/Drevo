import { expect, type FrameLocator, type Page } from "@playwright/test";
import { test } from "./fixtures/document-server";
import PDFDocument from "pdfkit";

async function uploadPdf(page: Page, title: string) {
  const pdf = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    pdf.on("end", () => resolve(Buffer.concat(chunks))),
  );
  for (let index = 1; index <= 5; index++) {
    pdf.addPage().text(`Archive page ${index}`);
  }
  pdf.end();
  const response = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: [] }),
      ),
    },
    data: await done,
  });
  expect(response.status()).toBe(201);
  return (await response.json()).id as string;
}

async function checkNativeLabels(book: FrameLocator) {
  for (const [selector, label] of [
    [".toggle_slider", "Переключить управление страницами"],
    [".book_left", "Предыдущая страница"],
    [".book_right", "Следующая страница"],
    [".onepg", "Одна страница"],
    [".twopg", "Разворот"],
    [".thumb", "Миниатюры страниц"],
    [".zoom_in", "Увеличить масштаб"],
    [".zoom_out", "Уменьшить масштаб"],
  ]) {
    const controls = book.locator(`.BRnav .BRicon${selector}`);
    expect(await controls.count()).toBeGreaterThan(0);
    for (const control of await controls.all()) {
      await expect(control).toHaveAttribute("aria-label", label);
      if (await control.isVisible())
        await expect(control).toHaveAccessibleName(label);
      await expect(control).toHaveAttribute("title", label);
      await expect(control.locator(".BRtooltip")).toHaveText(label);
    }
  }
  await expect(book.locator(".BRtoolbar .info")).toHaveAttribute(
    "title",
    "О документе",
  );
  await expect(book.locator(".BRsearchSubmit")).toHaveAccessibleName("Найти");
  await expect(book.locator(".BRsearchSubmit")).toHaveAttribute(
    "title",
    "Найти",
  );
  for (const slider of await book.locator(".ui-slider-handle").all()) {
    await expect(slider).toHaveAttribute("aria-label", "Перейти к странице");
    if (await slider.isVisible())
      await expect(slider).toHaveAccessibleName("Перейти к странице");
  }
  const images = book.locator("img.BRpageimage");
  expect(await images.count()).toBeGreaterThan(0);
  expect(
    await images.evaluateAll((elements) =>
      elements.every((image) => {
        const container = image.closest<HTMLElement>("[data-index]");
        return (
          image.getAttribute("alt") ===
          `Страница ${Number(container?.dataset.index) + 1} документа`
        );
      }),
    ),
  ).toBe(true);
}

test("русские native подписи сохраняются при перелистывании, смене режима и перестроении ридера", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await uploadPdf(page, "Проверка русского ридера");
  await page.goto(`/documents/${id}`);
  const book = page.frameLocator("iframe.pdf-book-frame");
  await expect(
    book.locator('.BRpage-visible[data-index="0"] img.BRpageimage').first(),
  ).toBeVisible();
  await checkNativeLabels(book);
  await book
    .getByRole("button", { name: "Следующая страница" })
    .filter({ visible: true })
    .first()
    .click();
  await expect(
    book.locator('.BRpage-visible[data-index="2"] img.BRpageimage').first(),
  ).toBeVisible();
  await checkNativeLabels(book);

  await book.locator(".BRicon.thumb:visible").click();
  await expect(
    book.locator(".BRpagecontainer.pagediv1 img.BRpageimage"),
  ).toBeVisible();
  await checkNativeLabels(book);
  await book.locator(".BRpagecontainer.pagediv1 img.BRpageimage").click();
  await expect(book.locator("br-mode-1up")).toBeVisible();
  await expect(book.locator(".BRicon.viewmode")).toHaveAttribute(
    "aria-label",
    "Разворот",
  );
  await expect(book.locator(".BRicon.viewmode")).toHaveAttribute(
    "title",
    "Разворот",
  );
  await checkNativeLabels(book);

  await page.setViewportSize({ width: 390, height: 844 });
  // Start the mobile cycle in its normal one-page mode. The pinned library
  // keeps a separate cycle order after desktop thumbnail selection.
  await book
    .getByRole("button", { name: "Закрыть документ", exact: true })
    .click();
  await page.getByRole("button", { name: /^Проверка русского ридера/ }).click();
  await expect(book.locator("br-mode-1up")).toBeVisible();
  await expect(book.locator(".BRicon.viewmode")).toHaveAccessibleName(
    "Разворот",
  );
  await book.locator(".BRicon.viewmode:visible").click();
  await expect(book.locator("br-mode-2up")).toBeVisible();
  await expect(book.locator(".BRicon.viewmode")).toHaveAccessibleName(
    "Миниатюры страниц",
  );
  await checkNativeLabels(book);

  const fullscreen = book.locator(".BRicon.full");
  await fullscreen.click();
  await expect(fullscreen).toHaveAccessibleName(
    "Выйти из полноэкранного режима",
  );
  await expect(fullscreen).toHaveAttribute(
    "title",
    "Выйти из полноэкранного режима",
  );
  await fullscreen.click();
  await expect(fullscreen).toHaveAccessibleName("Полноэкранный режим");
  await expect(fullscreen).toHaveAttribute("title", "Полноэкранный режим");

  await book.getByRole("button", { name: "О документе", exact: true }).click();
  await expect(book.locator(".BRinfo .BRfloatHead")).toHaveText(
    "О документе Закрыть сведения",
  );
  await book
    .getByRole("button", { name: "Закрыть сведения", exact: true })
    .click();
  await expect(book.locator("#colorbox")).toBeHidden();
  const query = book.getByRole("searchbox", { name: "Поиск в документе" });
  await query.fill("Archive page 5");
  await query.press("Enter");
  await expect
    .poll(() => book.locator("body").ariaSnapshot())
    .toContain("1 / 1");
  await expect(book.locator(".BRnavMain .BRsearch")).toHaveAttribute(
    "title",
    "Перейти к совпадению",
  );
  await expect(book.locator(".BRnavMain .BRquery footer")).toHaveText(
    "Страница 5",
  );
  await expect(
    book.locator('.BRpage-visible[data-index="4"] img.BRpageimage').first(),
  ).toBeVisible();
  for (const label of [
    "Предыдущее совпадение",
    "Следующее совпадение",
    "Очистить поиск",
  ]) {
    const control = book.getByRole("button", { name: label, exact: true });
    await expect(control).toHaveAttribute("title", label);
  }
  await checkNativeLabels(book);
  expect(await book.locator("body").ariaSnapshot()).not.toMatch(
    /Toggle page controls|Two-page view|Go fullscreen|About this book|Book page image|Previous result|Next result|Clear search results/,
  );

  await book
    .getByRole("button", { name: "Закрыть документ", exact: true })
    .click();
  await expect(page.locator("iframe.pdf-book-frame")).toHaveCount(0);
  await page.getByRole("button", { name: /^Проверка русского ридера/ }).click();
  await expect(
    book.locator('.BRpage-visible[data-index="0"] img.BRpageimage').first(),
  ).toBeVisible();
  await checkNativeLabels(book);
});

test("каталог склоняет 1, 2 и 5 документов", async ({ page }) => {
  for (let count = 1; count <= 5; count++) {
    await uploadPdf(page, `Документ ${count}`);
    if (![1, 2, 5].includes(count)) continue;
    await page.goto("/documents");
    await expect(page.locator(".documents-count")).toHaveText(
      count === 1 ? "1 документ" : count === 2 ? "2 документа" : "5 документов",
    );
  }
});

test("карта склоняет места и сохраняет русские подписи Leaflet после повторного открытия", async ({
  page,
}) => {
  const initial = await (await page.request.get("/api/family")).json();
  let count = 1;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({
      json: {
        ...initial,
        partial: false,
        family: {
          ...initial.family,
          photos: [],
          links: [],
          people: [
            {
              id: "locale-person",
              surname: "Проверкин",
              name: "Иван",
              patronymic: "",
              sex: "m",
              birth: "1940-01-01",
              generation: 1,
              column: 0,
              sources: [],
              parents: [],
              spouses: [],
              events: [],
              birthPlace: "Москва",
              deathPlace: count === 2 ? "Тула" : "",
            },
          ],
        },
      },
    }),
  );
  await page.route("**/api/places/locate?*", (route) =>
    route.fulfill({
      json: {
        automatic: { lat: 55.75, lon: 37.62, name: "Москва", label: "Москва" },
        candidates: [],
      },
    }),
  );
  await page.route("**/api/family?projection=places&*", (route) =>
    route.fulfill({
      json: {
        ...initial,
        people: [{ id: "locale-person", events: [] }],
        photos: [],
      },
    }),
  );
  await page.route("**://tile.openstreetmap.org/**", (route) => route.abort());
  for (count of [1, 2]) {
    await page.goto("/places");
    await expect(page.locator(".places-sidebar .places-count")).toHaveText(
      count === 1 ? "1 место · 1 на карте" : "2 места · 2 на карте",
    );
    for (const label of ["Увеличить масштаб", "Уменьшить масштаб"]) {
      const control = page.getByRole("button", { name: label, exact: true });
      await expect(control).toHaveAttribute("title", label);
      await control.focus();
      await page.keyboard.press("Enter");
      await expect(control).toBeFocused();
    }
    expect(
      await page.locator(".family-map-surface").ariaSnapshot(),
    ).not.toMatch(/Zoom in|Zoom out/);
    await page.goto("/documents");
  }
});
