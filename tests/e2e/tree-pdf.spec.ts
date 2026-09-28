import { expect, test } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

test("PDF respects collapsed branches and cancelling preparation releases the document", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.print = () => {
      document.documentElement.dataset.printRequested = "true";
    };
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
  await page
    .getByTestId("rf__node-e2e-child")
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ })
    .click();
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-layout-settling/,
  );
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog.getByRole("button", { name: "Сохранить древо в PDF" }).click();
  const frame = page.frameLocator("iframe[data-tree-print]");
  await expect(frame.locator("html")).toHaveAttribute(
    "data-print-requested",
    "true",
  );
  await expect(frame.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await expect(frame.locator(".tree-print-canvas")).toHaveCSS(
    "background-color",
    "rgba(0, 0, 0, 0)",
  );
  await expect(frame.locator('[data-person-id="e2e-grandchild"]')).toHaveCount(
    0,
  );
  await expect(
    frame.locator('[data-person-id="e2e-sibling-child"]'),
  ).toHaveCount(1);
  await frame
    .locator("body")
    .evaluate(() => window.dispatchEvent(new Event("afterprint")));
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
  let release!: () => void;
  const loading = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/*.css", async (route) => {
    if (route.request().frame().name() === "drevo-pdf") await loading;
    await route.continue();
  });
  await dialog.getByRole("button", { name: "Сохранить древо в PDF" }).click();
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(1);
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
  release();
  await expect(page.locator(".tree-canvas")).toBeVisible();
});

test("a wide tree with 201 people remains one custom page with vector text", async ({
  page,
  context,
  isMobile,
}, testInfo) => {
  test.skip(isMobile);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    window.print = () => {
      document.documentElement.dataset.printRequested = "true";
    };
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.family.people = Array.from({ length: 201 }, (_, index) => ({
      id: `pdf-${index}`,
      name: index ? `Потомок${index}` : "Основатель",
      surname: "Тестовый",
      sex: "m",
      birth: index ? "1930-01-01" : "1900-01-01",
      patronymic: "",
      birthPlace: "",
      sources: [],
      parents: index ? ["pdf-0"] : [],
      spouses: [],
      generation: index ? 2 : 1,
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
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await page.getByRole("button", { name: "Сохранить древо в PDF" }).click();
  const frame = page.frameLocator("iframe[data-tree-print]");
  await expect(frame.locator("html")).toHaveAttribute(
    "data-print-requested",
    "true",
    { timeout: 15_000 },
  );
  await expect(frame.locator(".flow-person")).toHaveCount(201);
  const size = await frame.locator("body").evaluate((node) => ({
    width: node.clientWidth,
    height: node.clientHeight,
  }));
  expect(Math.max(size.width, size.height)).toBe(19_000);
  const html = await frame.locator("html").evaluate((node) => node.outerHTML);
  const printPage = await context.newPage();
  await printPage.route("**/__tree_pdf_test", (route) =>
    route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html>${html}`,
    }),
  );
  await printPage.goto("/__tree_pdf_test", { waitUntil: "networkidle" });
  await printPage.evaluate(() => document.fonts.ready);
  const buffer = await printPage.pdf({
    path: testInfo.outputPath("large-tree.pdf"),
    preferCSSPageSize: true,
    printBackground: true,
  });
  await printPage.close();
  const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
  try {
    expect(pdf.numPages).toBe(1);
    const first = await pdf.getPage(1);
    expect(first.getViewport({ scale: 1 }).width).toBeCloseTo(14_250, 0);
    const text = (await first.getTextContent()).items
      .flatMap((item) => ("str" in item ? item.str : []))
      .join(" ");
    expect(text).toContain("Основатель");
    for (let index = 1; index <= 200; index++)
      expect(text).toContain(`Потомок${index}`);
  } finally {
    await pdf.loadingTask.destroy();
  }
});

for (const variant of ["portrait", "classic"] as const)
  test(`all expanded ${variant} tree exports as one vector PDF independently of the camera`, async ({
    page,
    context,
    isMobile,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    // Keep the prepared print document available for Chromium's PDF renderer.
    await page.addInitScript(() => {
      window.print = () => {
        document.documentElement.dataset.printRequested = "true";
      };
    });
    const data = await (await page.request.get("/api/family")).json();
    const photo = await sharp({
      create: { width: 100, height: 100, channels: 3, background: "#31779a" },
    })
      .png()
      .toBuffer();
    data.family.people.find(
      (person: { id: string }) => person.id === "e2e-child",
    ).photo = "/media/pdf-portrait.png";
    const token = "p".repeat(43);
    await context.route("**/media/pdf-portrait.png**", (route) =>
      route.fulfill({ contentType: "image/png", body: photo }),
    );
    await page.route(`**/api/shared/${token}`, (route) =>
      route.fulfill({
        json: {
          family: data.family,
          reverseTimeline: false,
          serverTime: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
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
    const canvas = page.locator(".tree-canvas");
    await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
    // Zoom into one person: most of the tree is now outside the screen.
    const card = page
      .getByTestId("rf__node-e2e-child")
      .locator(".flow-person-content");
    if (isMobile) {
      const box = (await card.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + box.width / 2 + 150,
        box.y + box.height / 2 + 80,
        { steps: 5 },
      );
      await page.mouse.up();
    } else await card.click();
    const camera = await page
      .locator(".react-flow__viewport")
      .getAttribute("style");
    await page.getByRole("button", { name: "Настройки древа" }).click();
    const dialog = page.getByRole("dialog", { name: "Вид древа" });
    await dialog.getByRole("button", { name: "Сохранить древо в PDF" }).click();
    const frame = page.frameLocator("iframe[data-tree-print]");
    await expect(frame.locator("html")).toHaveAttribute(
      "data-print-requested",
      "true",
      { timeout: 15_000 },
    );
    await expect(dialog.getByRole("status")).toHaveText("Окно печати открыто.");
    await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
      "style",
      camera!,
    );
    const ids = await frame
      .locator(".flow-person")
      .evaluateAll((nodes) =>
        nodes.map((node) => node.getAttribute("data-person-id")),
      );
    expect(new Set(ids)).toEqual(
      new Set(data.family.people.map((person: { id: string }) => person.id)),
    );
    await expect(frame.locator(".react-flow__viewport")).toHaveCSS(
      "transform",
      /matrix\(1, 0, 0, 1,/,
    );
    expect(
      await frame.locator(".react-flow__edge-path").count(),
    ).toBeGreaterThan(0);
    const html = await frame.locator("html").evaluate((node) => node.outerHTML);
    const dimensions = await frame.locator("body").evaluate((node) => ({
      width: node.clientWidth,
      height: node.clientHeight,
    }));
    // Print the exact prepared document through the same Chromium print engine.
    const printPage = await context.newPage();
    await printPage.setViewportSize(dimensions);
    await printPage.route("**/__tree_pdf_test", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: `<!doctype html>${html}`,
      }),
    );
    await printPage.goto("/__tree_pdf_test", { waitUntil: "networkidle" });
    await printPage.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(Array.from(document.images, (image) => image.decode()));
    });
    const reference = await printPage.screenshot({
      path: testInfo.outputPath("browser.png"),
      scale: "css",
    });
    const buffer = await printPage.pdf({
      path: testInfo.outputPath("tree.pdf"),
      preferCSSPageSize: true,
      printBackground: true,
    });
    await printPage.close();
    const pdf = await getDocument({ data: new Uint8Array(buffer) }).promise;
    try {
      expect(pdf.numPages).toBe(1);
      const first = await pdf.getPage(1);
      const points = first.getViewport({ scale: 1 });
      expect(Math.abs(points.width - dimensions.width * 0.75)).toBeLessThan(1);
      expect(Math.abs(points.height - dimensions.height * 0.75)).toBeLessThan(
        1,
      );
      // Text remains real text rather than a bitmap, including off-screen people.
      const text = (await first.getTextContent()).items
        .flatMap((item) => ("str" in item ? item.str : []))
        .join(" ");
      expect(text).toContain("Тестов");
      expect(text).toContain("1940");
      expect(text).toContain("Анна");
      const viewport = first.getViewport({ scale: 96 / 72 });
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
      await writeFile(testInfo.outputPath("pdf.png"), png);
      const expected = await sharp(reference)
        .resize(Math.round(viewport.width), Math.round(viewport.height))
        .blur(1)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const actual = await sharp(png)
        .blur(1)
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(actual.info.width).toBe(expected.info.width);
      expect(actual.info.height).toBe(expected.info.height);
      expect(actual.data.length).toBe(expected.data.length);
      let changed = 0;
      for (let offset = 0; offset < actual.data.length; offset += 3)
        if (
          [0, 1, 2].some(
            (channel) =>
              Math.abs(
                actual.data[offset + channel] - expected.data[offset + channel],
              ) > 30,
          )
        )
          changed++;
      const fraction = changed / (actual.info.width * actual.info.height);
      await testInfo.attach("pixel-comparison", {
        body: JSON.stringify({ changedPixelFraction: fraction }),
        contentType: "application/json",
      });
      // Chromium print and pdf.js use different font rasterizers. The compared
      // images retain the same cards and routes; allow their edge pixels.
      expect(fraction).toBeLessThan(0.02);
    } finally {
      await pdf.loadingTask.destroy();
    }
    // Releasing the print preview also releases its React tree and resources.
    await frame
      .locator("body")
      .evaluate(() => window.dispatchEvent(new Event("afterprint")));
    await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
  });
