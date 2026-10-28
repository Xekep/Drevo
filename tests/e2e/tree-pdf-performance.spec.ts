import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import sharp from "sharp";

async function sharedFixture(
  page: Page,
  count: number,
  photo: (index: number) => string,
) {
  const token = "b".repeat(43);
  await page.route(`**/api/shared/${token}`, (route) =>
    route.fulfill({
      json: {
        family: {
          title: "PDF benchmark",
          description: "",
          demo: false,
          people: Array.from({ length: count }, (_, index) => ({
            id: `pdf-bench-${index}`,
            name: `Человек${index}`,
            surname: "Тестовый",
            patronymic: "Александрович",
            sex: "m",
            birth: "1900-01-01",
            birthPlace: "",
            sources: [],
            parents: [],
            spouses: [],
            photo: photo(index),
            generation: 1,
            column: index,
          })),
          links: [],
          photos: [],
        },
        reverseTimeline: false,
        serverTime: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      },
    }),
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/s/${token}`);
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-ready",
    "true",
  );
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-grow|is-layout-settling/,
  );
}

test("PDF reuses portraits without dropping people or rasterizing text", async ({
  page,
  context,
  isMobile,
}, info) => {
  test.skip(isMobile, "Canvas export is available on desktop");
  const count = 100;
  const portrait = await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: "#31779a",
    },
  })
    .png()
    .toBuffer();
  let originals = 0;
  await context.route("**/media/pdf-benchmark.png**", (route) => {
    if (route.request().resourceType() === "fetch") {
      expect(new URL(route.request().url()).searchParams.get("variant")).toBe("print");
      originals++;
    }
    return route.fulfill({ contentType: "image/png", body: portrait });
  });
  await sharedFixture(page, count, () => "/media/pdf-benchmark.png");
  const samples: { ms: number; bytes: number }[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await page
      .locator(".react-flow__pane")
      .click({ button: "right", position: { x: 40, y: 350 } });
    await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
    const dialog = page.getByRole("dialog");
    const pending = page.waitForEvent("download");
    const started = performance.now();
    await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
    const download = await pending;
    const ms = performance.now() - started;
    const path = info.outputPath(`portraits-${attempt}.pdf`);
    await download.saveAs(path);
    const bytes = await readFile(path);
    expect(originals).toBe(attempt + 1);
    samples.push({ ms, bytes: bytes.length });
    const pdf = await getDocument({ data: new Uint8Array(bytes) }).promise;
    try {
      expect(pdf.numPages).toBe(1);
      const first = await pdf.getPage(1);
      const text = (await first.getTextContent()).items
        .flatMap((item) => ("str" in item ? [item.str] : []))
        .join(" ");
      for (let index = 0; index < count; index++)
        expect(text).toContain(`Человек${index}`);
      const ops = await first.getOperatorList();
      expect(
        ops.fnArray.filter((op) => op === OPS.paintImageXObject),
      ).toHaveLength(count);
      expect(first.getViewport({ scale: 1 }).width).toBeGreaterThan(
        first.getViewport({ scale: 1 }).height,
      );
    } finally {
      await pdf.loadingTask.destroy();
    }
    await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
    await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  }
  await info.attach("pdf-export-timing", {
    body: JSON.stringify(samples),
    contentType: "application/json",
  });
  console.log("PDF_EXPORT_TIMING", JSON.stringify(samples));
});

test("PDF bounds original photo requests and cancels them without a late download", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Canvas export is available on desktop");
  const portrait = await sharp({
    create: {
      width: 1600,
      height: 1200,
      channels: 3,
      background: "#31779a",
    },
  })
    .png()
    .toBuffer();
  const count = 12;
  let started = 0,
    active = 0,
    peak = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route("**/media/pdf-unique-*", async (route) => {
    if (route.request().resourceType() !== "fetch") {
      await route.fulfill({ contentType: "image/png", body: portrait });
      return;
    }
    started++;
    peak = Math.max(peak, ++active);
    await gate;
    try {
      await route.fulfill({ contentType: "image/png", body: portrait });
    } finally {
      active--;
    }
  });
  await sharedFixture(page, count, (index) => `/media/pdf-unique-${index}.png`);
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  await page
    .locator(".react-flow__pane")
    .click({ button: "right", position: { x: 40, y: 350 } });
  await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  try {
    await expect.poll(() => started).toBe(4);
    await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
    await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
  } finally {
    release();
  }
  await expect.poll(() => active).toBe(0);
  expect(started).toBe(4);
  expect(peak).toBe(4);
  expect(downloaded).toBe(false);
  await page
    .locator(".react-flow__pane")
    .click({ button: "right", position: { x: 40, y: 350 } });
  await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
  const pending = page.waitForEvent("download");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Скачать", exact: true })
    .click();
  await pending;
  expect(started).toBe(4 + count);
  expect(peak).toBeLessThanOrEqual(4);
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
});

test("an unreadable original reports an error instead of downloading an incomplete PDF", async ({
  page,
  context,
  isMobile,
}) => {
  test.skip(isMobile, "Canvas export is available on desktop");
  await context.route("**/media/pdf-broken.png**", (route) =>
    route.fulfill({ contentType: "image/png", body: "not an image" }),
  );
  await sharedFixture(page, 1, () => "/media/pdf-broken.png");
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  await page
    .locator(".react-flow__pane")
    .click({ button: "right", position: { x: 40, y: 350 } });
  await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(page.locator("iframe[data-tree-print]")).toHaveCount(0);
  expect(downloaded).toBe(false);
});
