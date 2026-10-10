import { expect, test, type Page } from "@playwright/test";
import PDFDocument from "pdfkit";
import sharp from "sharp";
import { openAdminSection } from "./admin-navigation";

async function pdfPages() {
  const pdf = new PDFDocument();
  const parts: Buffer[] = [];
  pdf.on("data", (part: Buffer) => parts.push(part));
  const finished = new Promise<Buffer>((resolve) =>
    pdf.on("end", () => resolve(Buffer.concat(parts))),
  );
  for (let i = 0; i < 3; i++) {
    if (i) pdf.addPage();
    pdf.text(`Responsive reader regression: page ${i + 1}`);
  }
  pdf.end();
  return finished;
}

async function headerLink(page: Page, path: string) {
  const links = page.locator(`.archive-header a[href="${path}"]`);
  if (!(await links.filter({ visible: true }).count()))
    await page.locator(".archive-more > summary").click();
  return links.filter({ visible: true }).first();
}

test("черновик документа защищён при переходе в другой раздел", async ({
  page,
}) => {
  await page.goto("/documents");
  await page
    .getByRole("button", { name: "Добавить документ", exact: true })
    .click();
  const form = page.locator(".documents-upload");
  await form
    .getByLabel("Название", { exact: true })
    .fill("Не потерять черновик");
  // Closing the form keeps its draft; navigation, which unmounts it, must warn.
  await form.getByRole("button", { name: "Закрыть форму" }).click();
  await page
    .getByRole("button", { name: "Добавить документ", exact: true })
    .click();
  await expect(form.getByLabel("Название", { exact: true })).toHaveValue(
    "Не потерять черновик",
  );
  let prompts = 0;
  page.on("dialog", async (dialog) => {
    prompts++;
    await dialog.dismiss();
  });
  await (await headerLink(page, "/people")).click();
  await expect(page).toHaveURL(/\/documents$/);
  await expect(form.getByLabel("Название", { exact: true })).toHaveValue(
    "Не потерять черновик",
  );
  expect(prompts).toBe(1);
  await form.getByLabel("Название", { exact: true }).fill("");
  await (await headerLink(page, "/people")).click();
  await expect(page).toHaveURL(/\/people$/);
  expect(prompts).toBe(1);
});

test("черновик источника сохраняется при отказе от переключения и не мешает после сохранения", async ({
  page,
}, info) => {
  await page.goto("/manage");
  await openAdminSection(page, "sources", "Источники");
  await page.getByRole("button", { name: "Добавить источник" }).click();
  const editor = page.locator(".source-catalog-editor");
  const title = `Черновик источника ${info.project.name}`;
  await editor.getByLabel("Название", { exact: true }).fill(title);
  let prompts = 0;
  page.on("dialog", async (dialog) => {
    prompts++;
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Добавить источник" }).click();
  await expect(editor.getByLabel("Название", { exact: true })).toHaveValue(
    title,
  );
  await editor.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(editor).toBeVisible();
  await openAdminSection(page, "data", "Экспорт и импорт");
  await expect(editor).toBeVisible();
  expect(prompts).toBe(3);
  await editor.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(page.locator(".admin-notice")).toHaveText("Источник сохранён");
  await openAdminSection(page, "data", "Экспорт и импорт");
  await expect(
    page.getByRole("heading", { name: "Импорт", exact: true }),
  ).toBeVisible();
  expect(prompts).toBe(3);
});

test("выбранный клавиатурой результат поиска остаётся видимым", async ({
  page,
}) => {
  await page.goto("/manage");
  await openAdminSection(page, "invitations", "Приглашения");
  const input = page.getByRole("combobox", { name: "Кто это в древе" });
  await input.fill("Тест");
  await expect(page.getByRole("listbox", { name: "Найденные люди" }).getByRole("option")).toHaveCount(6);
  for (let i = 0; i < 6; i++) await input.press("ArrowDown");
  const visible = await input.evaluate((element) => {
    const active = document.getElementById(
      element.getAttribute("aria-activedescendant")!,
    )!;
    const list = active.closest("ul")!;
    const option = active.getBoundingClientRect(),
      bounds = list.getBoundingClientRect();
    return (
      option.top >= bounds.top - 1 &&
      option.bottom <= bounds.bottom + 1 &&
      list.scrollTop > 0
    );
  });
  expect(visible).toBe(true);
  await expect(input).toBeFocused();
  await input.press("Enter");
  await expect(input).toHaveValue(/Ольга/);
});

test("поиск людей документа показывает короткий запрос, загрузку, пустой результат и повтор ошибки", async ({
  page,
}) => {
  let attempt = 0;
  await page.route("**/api/people/search?*", async (route) => {
    attempt++;
    if (attempt === 1) {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await route.fulfill({ json: { people: [], hasMore: false } });
    } else if (attempt === 2)
      await route.fulfill({
        status: 503,
        json: { error: "Поиск временно недоступен" },
      });
    else
      await route.fulfill({
        json: {
          people: [
            { id: "e2e-child", label: "Тестов Пётр Иванович", detail: "1965" },
          ],
        },
      });
  });
  await page.goto("/documents");
  await page
    .getByRole("button", { name: "Добавить документ", exact: true })
    .click();
  const picker = page.locator(".document-people-picker");
  const input = picker.getByRole("combobox");
  await input.fill("Т");
  await expect(input).toHaveCSS("border-top-width", "0px");
  await expect(input).toHaveCSS("outline-width", "0px");
  await expect(picker.locator(".person-search-input")).toHaveCSS("outline-style", "solid");
  await expect(picker.getByRole("status")).toHaveText(
    "Введите хотя бы две буквы",
  );
  await input.fill("Тест");
  await expect(picker.getByRole("status")).toHaveText("Ищем…");
  await expect(picker.getByRole("status")).toContainText("Никого не найдено");
  await input.fill("Пётр");
  await expect(picker.getByRole("status")).toContainText(
    "Поиск временно недоступен",
  );
  await picker.getByRole("button", { name: "Повторить поиск" }).click();
  await picker.getByRole("option").click();
  await expect(picker.locator(".documents-selected-people")).toContainText(
    "Тестов Пётр Иванович",
  );
  expect(attempt).toBe(3);
});

test("PDF переживает повторные смены ширины и ручной выбор режима", async ({
  page,
}, info) => {
  const title = `Responsive PDF ${info.project.name}`;
  const upload = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: [] }),
      ),
    },
    data: await pdfPages(),
  });
  expect(upload.status()).toBe(201);
  const { id } = await upload.json();
  await page.setViewportSize({ width: 1440, height: 844 });
  await page.goto(`/documents/${id}`);
  const frame = page.frameLocator("iframe.pdf-book-frame");
  for (const width of [1440, 390, 1440, 320, 1440, 360, 768, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(
      frame.locator(".BRpage-visible img.BRpageimage").first(),
    ).toBeVisible();
    await expect
      .poll(() =>
        frame
          .locator(".BRpage-visible img.BRpageimage")
          .first()
          .evaluate(
            (image: HTMLImageElement) =>
              image.complete && image.naturalWidth > 0,
          ),
      )
      .toBe(true);
    // Wait for native debounce and virtualisation too: stale images may initially remain.
    await page.waitForTimeout(350);
    await expect(
      frame.locator(".BRpage-visible img.BRpageimage").first(),
    ).toBeVisible();
  }
  await page.setViewportSize({ width: 1440, height: 844 });
  await expect(frame.locator("#bookreader")).toHaveClass(/BRmode2up/);
  await frame.locator(".BRicon.onepg:visible").first().click();
  await page.setViewportSize({ width: 320, height: 844 });
  await page.setViewportSize({ width: 1024, height: 844 });
  await expect(frame.locator("#bookreader")).toHaveClass(/BRmode1up/);
  await expect(
    frame.locator(".BRpage-visible img.BRpageimage").first(),
  ).toBeVisible();
});

test("каталог людей поддерживает Ctrl и среднюю кнопку без перехода текущей вкладки", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "desktop",
    "Модификаторы мыши относятся к desktop",
  );
  await page.goto("/people");
  const person = page.locator(".directory-person").first();
  await expect(person).toHaveAttribute("href", /\/people\/e2e-/);
  for (const gesture of ["control", "middle"] as const) {
    const opened = page.context().waitForEvent("page");
    await person.click(
      gesture === "control" ? { modifiers: ["Control"] } : { button: "middle" },
    );
    const tab = await opened;
    await tab.waitForURL(/\/people\/e2e-/);
    await expect(page).toHaveURL(/\/people$/);
    await tab.close();
  }
});

test("мобильная загрузка фото доступна без запуска распознавания лиц", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile", "Проверка мобильной возможности");
  const heavyRequests: string[] = [];
  page.on("request", (request) => {
    if (/human\.esm|\/models\//.test(request.url()))
      heavyRequests.push(request.url());
  });
  await page.goto("/photos");
  await page.getByRole("button", { name: "Добавить фото" }).click();
  const dialog = page.getByRole("dialog", { name: "Добавить фотографию" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Выбрать фотографию")
    .setInputFiles({
      name: "mobile.png",
      mimeType: "image/png",
    buffer: await sharp({ create: { width: 320, height: 240, channels: 3, background: "#d3ddc9" } }).png().toBuffer(),
    });
  await dialog
    .getByRole("button", { name: "Сохранить фотографию", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Закрыть просмотр фото" }),
  ).toBeVisible();
  await expect(page.locator(".photo-viewer .photo-edit-toolbar")).toHaveCount(
    0,
  );
  expect(heavyRequests).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - innerWidth,
    ),
  ).toBeLessThanOrEqual(1);
});

test("графики ИИ учитывают смену reduced motion без пересоздания", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream",
      body: `event: done\ndata: ${JSON.stringify({
        answer:
          '```xychart\n title "Люди"\n x-axis [1900, 1950]\n bar [1, 4]\n```',
        references: [],
        suggestionIds: [],
        uiActions: [],
        files: [],
      })}\n\n`,
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await page.locator(".research-assistant textarea").fill("Покажи график");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".research-visual-plot canvas")).toBeVisible();
  const motionState = () =>
    page.evaluate(async () => {
      const url = performance
        .getEntriesByType("resource")
        .find((entry) => /\/echarts-runtime-.*\.js/.test(entry.name))!.name;
      const { echarts } = await import(url);
      const instance = echarts.getInstanceByDom(
        document.querySelector(".research-visual-plot"),
      );
      return {
        id: instance.id,
        animation: instance.getOption().animation,
        seriesAnimation: instance.getOption().series[0].animation,
      };
    });
  const reduced = await motionState();
  expect(reduced.animation).toBe(false);
  expect(reduced.seriesAnimation).toBe(false);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(async () => (await motionState()).animation).not.toBe(false);
  expect((await motionState()).id).toBe(reduced.id);
});
