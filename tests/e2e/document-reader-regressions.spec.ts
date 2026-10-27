import { expect } from "@playwright/test";
import { test } from "./fixtures/document-server";
import { readFileSync } from "node:fs";
import PDFDocument from "pdfkit";
import sharp from "sharp";

test("JPEG 2000 pages render real pixels with local decoders under production CSP", async ({
  page,
}) => {
  const csp = readFileSync("ops/nginx.conf", "utf8").match(
    /add_header Content-Security-Policy "([^"]+)"/,
  )![1];
  await page.route(
    /\/(?:bookreader-frame\.html|assets\/pdf\.worker[^/]*\.mjs)$/,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        headers: { ...response.headers(), "content-security-policy": csp },
      });
    },
  );
  const pdf = new PDFDocument({ size: [320, 320], margin: 0 });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) =>
    pdf.on("end", () => resolve(Buffer.concat(chunks))),
  );
  const image = pdf.ref({
    Type: "XObject",
    Subtype: "Image",
    Width: 32,
    Height: 32,
    ColorSpace: "DeviceRGB",
    BitsPerComponent: 8,
    Filter: "JPXDecode",
  });
  image.end(readFileSync("tests/fixtures/two-colors.jp2"));
  (
    pdf.page as unknown as { xobjects: Record<string, unknown> }
  ).xobjects.Sample = image;
  pdf.addContent("q 320 0 0 320 0 0 cm /Sample Do Q");
  pdf.end();
  const response = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: "JPEG 2000", personIds: [] }),
      ),
    },
    data: await done,
  });
  expect(response.status()).toBe(201);
  const failures: string[] = [];
  page.on("console", (message) => {
    if (
      /OpenJPEG failed|Unable to decode image|#instantiateWasm/.test(
        message.text(),
      )
    )
      failures.push(message.text());
  });
  await page.goto("/documents");
  await page.locator(".document-item").filter({ hasText: "JPEG 2000" }).click();
  const picture = page
    .frameLocator("iframe.pdf-book-frame")
    .locator(".BRpage-visible img.BRpageimage")
    .first();
  await expect
    .poll(
      async () =>
        picture.evaluate((img: HTMLImageElement) => {
          if (!img.naturalWidth) return false;
          const canvas = document.createElement("canvas");
          canvas.width = img.naturalWidth;
          canvas.height = img.naturalHeight;
          const context = canvas.getContext("2d")!;
          context.drawImage(img, 0, 0);
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          let red = 0,
            blue = 0;
          for (let i = 0; i < pixels.length; i += 4) {
            if (pixels[i] > 180 && pixels[i + 2] < 80) red++;
            if (pixels[i + 2] > 180 && pixels[i] < 80) blue++;
          }
          return (
            red > canvas.width * canvas.height * 0.3 &&
            blue > canvas.width * canvas.height * 0.3
          );
        }),
      { timeout: 20_000 },
    )
    .toBe(true);
  expect(failures).toEqual([]);
});

test("editing a document at the end of the catalog opens a visible dialog and restores list position", async ({
  page,
}, info) => {
  const buffer = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  const response = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "image/png",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: "Последний документ", personIds: [] }),
      ),
    },
    data: buffer,
  });
  expect(response.status()).toBe(201);
  const created = await response.json();
  const entry = await (
    await page.request.get(`/api/documents/${created.id}`)
  ).json();
  await page.route(/\/api\/documents\?/, (route) =>
    route.fulfill({
      json: {
        total: 30,
        items: Array.from({ length: 30 }, (_, i) =>
          i === 29
            ? entry
            : { ...entry, id: `fixture-${i}`, title: `Документ ${i}` },
        ),
      },
    }),
  );
  await page.goto("/documents");
  const edit = page.getByRole("button", {
    name: "Редактировать документ «Последний документ»",
    exact: true,
  });
  await edit.scrollIntoViewIfNeeded();
  const before = (await edit.boundingBox())!;
  await edit.click();
  const dialog = page.getByRole("dialog", {
    name: "Редактировать документ",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const rect = (await dialog.boundingBox())!;
  expect(rect.y).toBeGreaterThanOrEqual(0);
  expect(rect.y + rect.height).toBeLessThanOrEqual(
    page.viewportSize()!.height + 1,
  );
  await expect(dialog.getByLabel("Название", { exact: true })).toHaveValue(
    "Последний документ",
  );
  const save = (await dialog
    .getByRole("button", { name: "Сохранить", exact: true })
    .boundingBox())!;
  expect(save.y).toBeGreaterThanOrEqual(0);
  expect(save.y + save.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await page.screenshot({ path: info.outputPath("document-edit-dialog.png") });
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(edit).toBeFocused();
  expect(Math.abs((await edit.boundingBox())!.y - before.y)).toBeLessThan(2);
});
