import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

async function downloadPdf(page: Page, info: TestInfo) {
  // Test the actual download, never page.pdf() with preferCSSPageSize overrides.
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(dialog.getByText(/Личные настройки/)).toHaveCount(0);
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Сохранить древо в PDF" }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  const path = info.outputPath("tree.pdf");
  await download.saveAs(path);
  await expect(dialog.getByRole("status")).toHaveText("PDF готов.");
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
  const buffer = await readFile(path);
  expect(buffer.subarray(0, 8).toString("ascii")).toBe("%PDF-1.7");
  return getDocument({ data: new Uint8Array(buffer) }).promise;
}

test("selected descendants export to PDF, PNG and a deterministic report", async ({
  page,
  isMobile,
}, info) => {
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
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog.getByText("Параметры экспорта").click();
  await dialog
    .getByRole("combobox", { name: "Область экспорта" })
    .selectOption("descendants");
  await dialog
    .getByRole("combobox", { name: "Поколений для экспорта" })
    .selectOption("2");
  const pdfPending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Сохранить древо в PDF" }).click();
  const pdfDownload = await pdfPending;
  const pdfPath = info.outputPath("descendants.pdf");
  await pdfDownload.saveAs(pdfPath);
  const pdf = await getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
  }).promise;
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
  await dialog
    .getByRole("combobox", { name: "Формат изображения" })
    .selectOption("png");
  const pngPending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Сохранить древо в PNG" }).click();
  const pngDownload = await pngPending;
  const pngPath = info.outputPath("descendants.png");
  await pngDownload.saveAs(pngPath);
  const png = sharp(await readFile(pngPath));
  const metadata = await png.metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBeGreaterThan(1000);
  const colors = await png.stats();
  expect(colors.channels[0].stdev).toBeGreaterThan(2);
  const reportPending = page.waitForEvent("download");
  await dialog
    .getByRole("combobox", { name: "Направление росписи" })
    .selectOption("descendants");
  await dialog.getByRole("button", { name: "Скачать роспись" }).click();
  const report = await reportPending;
  expect(report.suggestedFilename()).toMatch(/\.txt$/);
  const reportPath = info.outputPath("descendants.txt");
  await report.saveAs(reportPath);
  const text = await readFile(reportPath, "utf8");
  expect(text).toContain("Анна");
  expect(text).not.toContain("Ольга");
  await dialog
    .getByRole("combobox", { name: "Тип PDF-отчёта" })
    .selectOption("descendants");
  const reportPdfPending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать PDF-отчёт" }).click();
  const reportPdfDownload = await reportPdfPending;
  expect(reportPdfDownload.suggestedFilename()).toMatch(/\.pdf$/);
  const reportPdfPath = info.outputPath("descendants-report.pdf");
  await reportPdfDownload.saveAs(reportPdfPath);
  const reportPdf = await getDocument({
    data: new Uint8Array(await readFile(reportPdfPath)),
  }).promise;
  try {
    const reportText = (await (await reportPdf.getPage(1)).getTextContent()).items
      .flatMap((item) => ("str" in item ? item.str : []))
      .join(" ");
    expect(reportText).toContain("Роспись потомков");
    expect(reportText).toContain("Анна");
    expect(reportText).not.toContain("Ольга");
  } finally {
    await reportPdf.loadingTask.destroy();
  }
  for (const [kind, title] of [
    ["person", "Карточка человека"],
    ["family", "Семейный отчёт"],
    ["timeline", "Хронология жизни"],
    ["ancestors", "Роспись предков"],
    ["research", "Исследовательская сводка"],
  ] as const) {
    await dialog.getByRole("combobox", { name: "Тип PDF-отчёта" }).selectOption(kind);
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Скачать PDF-отчёт" }).click();
    const download = await pending;
    const path = info.outputPath(`${kind}-report.pdf`);
    await download.saveAs(path);
    const file = await getDocument({
      data: new Uint8Array(await readFile(path)),
    }).promise;
    try {
      const text = (await (await file.getPage(1)).getTextContent()).items
        .flatMap((item) => ("str" in item ? item.str : []))
        .join(" ");
      expect(text).toContain(title);
      expect(text).toContain("Пётр");
    } finally {
      await file.loadingTask.destroy();
    }
  }
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
});

test("fan export respects generations, labels and output format", async ({
  page,
  isMobile,
}, info) => {
  const portrait = await sharp({
    create: { width: 120, height: 120, channels: 3, background: "#31779a" },
  })
    .png()
    .toBuffer();
  await page
    .context()
    .route("**/media/fan-portrait.png**", (route) =>
      route.fulfill({ contentType: "image/png", body: portrait }),
    );
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const overview = await response.json();
    overview.family.people.find(
      (person: { id: string }) => person.id === "e2e-child",
    ).photo = "/media/fan-portrait.png";
    await route.fulfill({ response, json: overview });
  });
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
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog.getByText("Параметры экспорта").click();
  await dialog.getByText("Экспорт веера").click();
  await dialog
    .getByRole("combobox", { name: "Поколений в веере" })
    .selectOption("2");
  await dialog.getByRole("checkbox", { name: "Портреты" }).check();
  const pdfPending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать веер · PDF" }).click();
  const pdfDownload = await pdfPending;
  const pdfPath = info.outputPath("fan.pdf");
  await pdfDownload.saveAs(pdfPath);
  const pdf = await getDocument({
    data: new Uint8Array(await readFile(pdfPath)),
  }).promise;
  try {
    expect(pdf.numPages).toBe(1);
    const content = (await (await pdf.getPage(1)).getTextContent()).items
      .flatMap((item) => ("str" in item ? item.str : []))
      .join(" ");
    expect(content).toContain("Пётр");
    expect(content).toContain("1940");
    expect((await (await pdf.getPage(1)).getOperatorList()).fnArray).toContain(
      OPS.paintImageXObject,
    );
  } finally {
    await pdf.loadingTask.destroy();
  }
  await dialog
    .getByRole("combobox", { name: "Формат изображения" })
    .selectOption("png");
  const pngPending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать веер · PNG" }).click();
  const pngDownload = await pngPending;
  const pngPath = info.outputPath("fan.png");
  await pngDownload.saveAs(pngPath);
  const metadata = await sharp(await readFile(pngPath)).metadata();
  expect(metadata.format).toBe("png");
  expect(metadata.width).toBeGreaterThan(500);
  const pixels = await sharp(await readFile(pngPath))
    .removeAlpha()
    .raw()
    .toBuffer();
  let portraitPixels = 0;
  for (let i = 0; i < pixels.length; i += 3)
    if (
      Math.abs(pixels[i] - 49) < 4 &&
      Math.abs(pixels[i + 1] - 119) < 4 &&
      Math.abs(pixels[i + 2] - 154) < 4
    )
      portraitPixels++;
  expect(portraitPixels).toBeGreaterThan(100);
});

test("A4 print preview and tiled PDF preserve names and landscape pages", async ({
  page,
}, info) => {
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog.getByText("Параметры экспорта").click();
  await dialog.getByText("Настройки печати PDF").click();
  await dialog
    .getByRole("combobox", { name: "Размер листа" })
    .selectOption("a4");
  await dialog.getByRole("combobox", { name: "Поля листа" }).selectOption("10");
  await dialog
    .getByRole("combobox", { name: "Масштаб печати" })
    .selectOption("1");
  await dialog.getByRole("button", { name: "Предпросмотр печати" }).click();
  await expect(
    dialog.getByRole("img", { name: "Расположение карточек на листах" }),
  ).toBeVisible();
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Сохранить древо в PDF" }).click();
  const download = await pending;
  const path = info.outputPath("tree-a4.pdf");
  await download.saveAs(path);
  const pdf = await getDocument({ data: new Uint8Array(await readFile(path)) })
    .promise;
  try {
    expect(pdf.numPages).toBeGreaterThan(1);
    let text = "";
    for (let index = 1; index <= pdf.numPages; index++) {
      const page = await pdf.getPage(index);
      const viewport = page.getViewport({ scale: 1 });
      expect(viewport.width).toBeGreaterThan(viewport.height);
      expect(viewport.width).toBeCloseTo(842, 0);
      text += (await page.getTextContent()).items
        .flatMap((item) => ("str" in item ? item.str : []))
        .join(" ");
    }
    expect(text).toContain("Пётр");
    expect(text).toContain("Анна");
  } finally {
    await pdf.loadingTask.destroy();
  }
  await dialog
    .getByRole("combobox", { name: "Ориентация листа" })
    .selectOption("portrait");
  const portraitPending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Сохранить древо в PDF" }).click();
  const portraitDownload = await portraitPending;
  const portraitPath = info.outputPath("tree-a4-portrait.pdf");
  await portraitDownload.saveAs(portraitPath);
  const portraitPdf = await getDocument({
    data: new Uint8Array(await readFile(portraitPath)),
  }).promise;
  try {
    const viewport = (await portraitPdf.getPage(1)).getViewport({ scale: 1 });
    expect(viewport.width).toBeLessThan(viewport.height);
  } finally {
    await portraitPdf.loadingTask.destroy();
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
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog.getByRole("button", { name: "Сохранить древо в PDF" }).click();
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
