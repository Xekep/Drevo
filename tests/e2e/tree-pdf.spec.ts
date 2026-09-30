import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

async function openExport(page: Page) {
  if (await page.evaluate(() => matchMedia("(max-width: 899px)").matches))
    await page.getByRole("button", { name: "Экспорт древа" }).click();
  else {
    await page
      .locator(".react-flow__pane")
      .click({ button: "right", position: { x: 40, y: 350 } });
    await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
  }
  return page.getByRole("dialog");
}

async function downloadPdf(page: Page, info: TestInfo) {
  const dialog = await openExport(page);
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /PDF/ }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const path = info.outputPath("tree.pdf");
  await download.saveAs(path);
  await expect(dialog.getByRole("status")).toHaveText(/PDF/);
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
  const buffer = await readFile(path);
  expect(buffer.subarray(0, 8).toString("ascii")).toBe("%PDF-1.7");
  return getDocument({ data: new Uint8Array(buffer) }).promise;
}

test("selected descendants export to PDF", async ({ page, isMobile }, info) => {
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  if (isMobile)
    await page.getByRole("button", { name: "Закрыть панель" }).click();
  const dialog = await openExport(page);
  await dialog
    .getByRole("combobox", { name: "Область экспорта" })
    .selectOption("descendants");
  await dialog
    .getByRole("combobox", { name: "Поколений для экспорта" })
    .selectOption("2");
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: /PDF/ }).click();
  const download = await pending;
  const path = info.outputPath("descendants.pdf");
  await download.saveAs(path);
  const pdf = await getDocument({ data: new Uint8Array(await readFile(path)) })
    .promise;
  try {
    const text = (await (await pdf.getPage(1)).getTextContent()).items
      .flatMap((item) => ("str" in item ? item.str : []))
      .join(" ");
    expect(text).toContain("Анна");
    expect(text).toContain("Пётр");
    expect(text).not.toContain("Ольга");
  } finally {
    await pdf.loadingTask.destroy();
  }
});

test.beforeEach(async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.print = () => {
      throw new Error("PDF must not invoke the printer");
    };
  });
});

test("settings have no export; canvas menu offers visible and full tree", async ({
  page,
}) => {
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const settings = page.getByRole("dialog");
  await expect(settings.locator("select")).toHaveCount(0);
  await settings.getByRole("button", { name: "Закрыть" }).click();
  const dialog = await openExport(page);
  const scope = dialog.getByRole("combobox", { name: "Область экспорта" });
  await expect(scope).toHaveValue("current");
  await expect(scope.locator('option[value="current"]')).toContainText(
    "Видимое древо",
  );
  await expect(scope.locator('option[value="all"]')).toContainText("Всё древо");
  await expect(dialog.getByRole("button", { name: /PDF/ })).toBeVisible();
  await expect(dialog.getByText("PNG", { exact: true })).toHaveCount(0);
});

test("person context menu shares only that person", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile);
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Временная ссылка" }).click();
  const dialog = page.getByRole("dialog", { name: "Поделиться человеком" });
  await expect(
    dialog.getByText("1 человек · просмотр без входа"),
  ).toBeVisible();
  await expect(
    dialog.getByText(/Ссылка не публикует его в поиске/),
  ).toBeVisible();
});

test("AI file action downloads the configured tree PDF", async ({ page }) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({
      json: { enabled: true, canPropose: false, streaming: true },
    }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({
        answer: "PDF древа готов к скачиванию.",
        references: [],
        suggestionIds: [],
        uiActions: [],
        files: [{ name: "PDF видимого древа", url: "drevo:tree-pdf:current" }],
      })}\n\n`,
    }),
  );
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const chat = page.locator(".research-assistant");
  await chat.getByRole("textbox").fill("Экспорт древа в PDF");
  await chat.getByRole("button", { name: "Отправить запрос" }).click();
  const pending = page.waitForEvent("download");
  await chat
    .getByRole("button", { name: "Скачать PDF видимого древа" })
    .click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
});

test("download respects collapsed branches; cancel releases preparation without downloading", async ({
  page,
}, info) => {
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
  await page
    .getByTestId("rf__node-e2e-child")
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ })
    .click();
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
  const pdf = await downloadPdf(page, info);
  try {
    const text = (await (await pdf.getPage(1)).getTextContent()).items
      .flatMap((item) => ("str" in item ? item.str : []))
      .join(" ");
    expect(text).not.toContain("Анна");
    expect(text).toContain("Ольга");
  } finally {
    await pdf.loadingTask.destroy();
  }
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/*.css", async (route) => {
    if (route.request().frame().name() === "drevo-pdf") await loading;
    await route.continue();
  });
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Скачать PDF" }).click();
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
  release();
  await expect(page.locator(".tree-canvas")).toBeVisible();
  expect(downloaded).toBe(false);
});

for (const shape of ["wide", "tall"] as const)
  test(`download of a ${shape} tree preserves landscape and full-size text on a large page`, async ({
    page,
    isMobile,
  }, info) => {
    test.skip(isMobile);
    const count = shape === "wide" ? 201 : 12;
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch(),
        data = await response.json();
      data.family.people = Array.from({ length: count }, (_, index) => ({
        id: `pdf-${index}`,
        name: index ? `Потомок${index}` : "Основатель",
        surname: "Тестовый",
        sex: "m",
        birth: `${shape === "wide" ? (index ? 1930 : 1900) : 1700 + index * 25}-01-01`,
        patronymic: "",
        birthPlace: "",
        sources: [],
        parents: index ? [`pdf-${shape === "wide" ? 0 : index - 1}`] : [],
        spouses: [],
        generation: shape === "wide" ? (index ? 2 : 1) : index + 1,
        column: index,
      }));
      data.family.links = [];
      data.family.photos = [];
      data.partial = false;
      data.user.personId = null;
      await route.fulfill({ response, json: data });
    });
    await page.goto("/tree");
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-grow|is-layout-settling/,
    );
    const pdf = await downloadPdf(page, info);
    try {
      expect(pdf.numPages).toBe(1);
      const first = await pdf.getPage(1),
        view = first.getViewport({ scale: 1 });
      expect(view.width).toBeGreaterThan(view.height);
      if (shape === "wide") {
        expect(view.width).toBeGreaterThan(14400);
        expect(first.userUnit).toBeGreaterThan(1);
      }
      const items = (await first.getTextContent()).items;
      const names = items.filter(
        (item) => "str" in item && /Основатель|Потомок/.test(item.str),
      );
      expect(names.length).toBeGreaterThanOrEqual(count);
      for (const name of names)
        if ("height" in name)
          expect(name.height * first.userUnit).toBeGreaterThanOrEqual(11.9);
      const text = items
        .flatMap((item) => ("str" in item ? item.str : []))
        .join(" ");
      for (let index = 1; index < count; index++)
        expect(text).toContain(`Потомок${index}`);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });

for (const variant of ["portrait", "classic"] as const)
  test(`${variant} download includes off-screen people, original portraits and vector routes`, async ({
    page,
    context,
    isMobile,
  }, info) => {
    const data = await (await page.request.get("/api/family")).json();
    const portrait = await sharp({
      create: { width: 800, height: 800, channels: 3, background: "#31779a" },
    })
      .png()
      .toBuffer();
    data.family.people.find((p: { id: string }) => p.id === "e2e-child").photo =
      "/media/pdf-portrait.png";
    const token = "p".repeat(43);
    await context.route("**/media/pdf-portrait.png**", (route) =>
      route.fulfill({ contentType: "image/png", body: portrait }),
    );
    await page.route(`**/api/shared/${token}`, (route) =>
      route.fulfill({
        json: {
          family: data.family,
          reverseTimeline: false,
          serverTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        },
      }),
    );
    await page.addInitScript(
      ({ variant }) =>
        localStorage.setItem(
          "drevo:guest-tree-preferences:v1",
          JSON.stringify({
            reverseTimeline: false,
            cardVariant: variant,
            colorScheme: variant === "classic" ? "white" : "warm",
          }),
        ),
      { variant },
    );
    await page.goto(`/s/${token}`);
    await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
    if (isMobile)
      await expect(page.locator(".react-flow__viewport")).not.toHaveAttribute(
        "style",
        /scale\(1\)/,
      );
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-grow|is-layout-settling/,
    );
    const extra = page.getByRole("button", { name: "Доп. связи" });
    await expect(extra).toHaveAttribute("aria-pressed", "false");
    await extra.click();
    await expect(extra).toHaveAttribute("aria-pressed", "true");
    const canvas = page.locator(".react-flow__pane");
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 30, box.y + 100);
    await page.mouse.down();
    await page.mouse.move(box.x + 300, box.y + 180, { steps: 5 });
    await page.mouse.up();
    const camera = await page
      .locator(".react-flow__viewport")
      .getAttribute("style");
    const pdf = await downloadPdf(page, info);
    await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
      "style",
      camera!,
    );
    try {
      expect(pdf.numPages).toBe(1);
      const first = await pdf.getPage(1),
        viewport = first.getViewport({ scale: 96 / 72 });
      expect(viewport.width).toBeGreaterThan(viewport.height);
      const text = (await first.getTextContent()).items
        .flatMap((item) => ("str" in item ? item.str : []))
        .join(" ");
      expect(text).toContain("Тестов");
      expect(text).toContain("1940");
      expect(text).toContain("Анна");
      expect(text).toContain("крестница");
      expect(text).not.toContain("Нет привязки");
      const ops = await first.getOperatorList();
      expect(ops.fnArray).toContain(OPS.constructPath);
      expect(ops.fnArray).toContain(OPS.paintImageXObject);
      const factory = pdf.canvasFactory as {
        create: (
          w: number,
          h: number,
        ) => {
          canvas: HTMLCanvasElement & { toBuffer: (mime: string) => Buffer };
          context: CanvasRenderingContext2D;
        };
      };
      const rendered = factory.create(
        Math.round(viewport.width),
        Math.round(viewport.height),
      );
      await first.render({
        canvas: rendered.canvas,
        canvasContext: rendered.context,
        viewport,
      }).promise;
      const png = rendered.canvas.toBuffer("image/png");
      await writeFile(info.outputPath("pdf.png"), png);
      const pixels = await sharp(png).removeAlpha().raw().toBuffer();
      expect([...pixels.subarray(0, 3)]).toEqual([255, 255, 255]);
      let portraitPixels = 0;
      for (let i = 0; i < pixels.length; i += 3)
        if (
          Math.abs(pixels[i] - 49) < 4 &&
          Math.abs(pixels[i + 1] - 119) < 4 &&
          Math.abs(pixels[i + 2] - 154) < 4
        )
          portraitPixels++;
      expect(portraitPixels).toBeGreaterThan(1000);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
