import { expect } from "@playwright/test";
import { test } from "./fixtures/document-server";
import PDFDocument from "pdfkit";

test("one-page documents swipe horizontally without stealing vertical scroll or zoom", async ({ page, isMobile }, info) => {
  test.skip(!isMobile);
  const pdf = new PDFDocument({ autoFirstPage: false });
  const chunks: Buffer[] = [];
  pdf.on("data", chunk => chunks.push(chunk));
  const complete = new Promise<Buffer>(resolve => pdf.on("end", () => resolve(Buffer.concat(chunks))));
  for (let i = 1; i <= 3; i++) pdf.addPage().text(`Page ${i}`);
  pdf.end();
  const response = await page.request.post("/api/documents", { headers: {
    "Content-Type": "application/pdf",
    "X-Document-Metadata": encodeURIComponent(JSON.stringify({ title: "Swipe pages", personIds: [] })),
  }, data: await complete });
  expect(response.status()).toBe(201);
  const { id } = await response.json();
  await page.goto(`/documents/${id}`);
  const book = page.frameLocator("iframe.pdf-book-frame");
  const view = book.locator("br-mode-1up");
  await expect(view).toBeVisible();
  await expect.poll(() => book.locator('.BRpage-visible[data-index="0"] img').first()
    .evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(book.getByText("Страница 1 из 3", { exact: true })).toBeVisible();
  const session = await page.context().newCDPSession(page);
  const swipe = async (direction: -1 | 1, vertical = false) => {
    const bounds = (await view.boundingBox())!;
    const x = bounds.x + bounds.width * (direction < 0 ? 0.75 : 0.25);
    const y = bounds.y + bounds.height * 0.5;
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (const fraction of [0.1, 0.3, 0.6, 1])
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{
        x: x + (vertical ? 0 : direction * bounds.width * 0.5 * fraction),
        y: y + (vertical ? -bounds.height * 0.25 * fraction : 0),
      }] });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  };
  try {
    await swipe(1);
    await page.screenshot({ path: info.outputPath("swipe-first-page.png") });
    await expect(book.getByText("Страница 1 из 3", { exact: true })).toBeVisible();
    await swipe(-1);
    await expect(book.getByText("Страница 2 из 3", { exact: true })).toBeVisible();
    await swipe(-1);
    await expect(book.getByText("Страница 3 из 3", { exact: true })).toBeVisible();
    await swipe(-1);
    await expect(book.getByText("Страница 3 из 3", { exact: true })).toBeVisible();
    await swipe(1);
    await expect(book.getByText("Страница 2 из 3", { exact: true })).toBeVisible();
    const bounds = (await view.boundingBox())!;
    const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    const fingers = (distance: number) => [
      { id: 0, x: center.x - distance, y: center.y },
      { id: 1, x: center.x + distance, y: center.y },
    ];
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers(35) });
    for (const distance of [45, 65, 95, 130])
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers(distance) });
    await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => view.evaluate(element => element.scrollWidth - element.clientWidth)).toBeGreaterThan(2);
    await swipe(-1);
    await expect(book.getByText("Страница 2 из 3", { exact: true })).toBeVisible();
    const scrollTop = await view.evaluate(element => element.scrollTop);
    await swipe(-1, true);
    await expect.poll(() => view.evaluate(element => element.scrollTop)).toBeGreaterThan(scrollTop);
  } finally {
    await session.detach().catch(() => {});
  }
});
