import { expect, test as base } from "@playwright/test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import PDFDocument from "pdfkit";
import { startServer } from "../../src/server/index.ts";

// Destructive scenarios own their archive and upload quota instead of using
// the shared E2E account's hourly allowance.
const test = base.extend<{ documentServer: string }>({
  // Playwright requires a destructuring pattern even for a fixture without dependencies.
  // eslint-disable-next-line no-empty-pattern
  documentServer: async ({}, provide) => {
    const directory = mkdtempSync(join(tmpdir(), "drevo-document-delete-e2e-"));
    const app = await startServer(0, join(directory, "drevo.sqlite"), true);
    try {
      await provide(
        `http://127.0.0.1:${(app.server.address() as { port: number }).port}`,
      );
    } finally {
      await app.close();
      rmSync(directory, { recursive: true, force: true });
    }
  },
  baseURL: async ({ documentServer }, provide) => provide(documentServer),
});

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

async function samplePdf() {
  const pdf = new PDFDocument();
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve, reject) => {
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  pdf.text("Archive page 1");
  pdf.end();
  return done;
}

test("document deletion needs a second click and canceled confirmation sends no request", async ({
  page,
}, info) => {
  const titles = ["Первый", "Второй"].map(
    (name) => `Удаление документа ${name} ${info.project.name} ${info.retry}`,
  );
  const ids: string[] = [];
  for (const title of titles) {
    const upload = await page.request.post("/api/documents", {
      headers: {
        "Content-Type": "application/pdf",
        "X-Document-Metadata": encodeURIComponent(
          JSON.stringify({ title, personIds: [] }),
        ),
      },
      data: await samplePdf(),
    });
    expect(upload.status()).toBe(201);
    ids.push((await upload.json()).id);
  }
  await page.goto("/documents");
  await page.clock.install();
  const deleted: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE")
      deleted.push(new URL(request.url()).pathname);
  });
  let dialogs = 0;
  page.on("dialog", async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });
  const remove = (index: number) =>
    page.getByRole("button", {
      name: `Удалить документ «${titles[index]}»`,
      exact: true,
    });
  const confirm = (index: number) =>
    page.getByRole("button", {
      name: `Подтвердить удаление документа «${titles[index]}»`,
      exact: true,
    });
  await remove(0).click();
  await expect(confirm(0)).toHaveText("Удалить?");
  expect(
    (await page.request.get(`/api/documents/${ids[0]}/file`)).status(),
  ).toBe(200);
  expect(deleted).toEqual([]);
  await confirm(0).press("Escape");
  await expect(remove(0)).toBeVisible();
  await remove(0).dblclick();
  await expect(confirm(0)).toBeVisible();
  expect(deleted).toEqual([]);
  await page.getByRole("heading", { name: "Документы", exact: true }).click();
  await expect(remove(0)).toBeVisible();
  await remove(0).click();
  await remove(1).click();
  await expect(remove(0)).toBeVisible();
  await expect(confirm(1)).toBeVisible();
  await confirm(1).press("Tab");
  await expect(remove(1)).toBeVisible();
  await remove(1).click();
  await page.clock.fastForward(8001);
  await expect(remove(1)).toBeVisible();
  expect(deleted).toEqual([]);
  await remove(0).click();
  await page
    .locator(".document-item-row")
    .filter({ hasText: titles[0] })
    .screenshot({ path: info.outputPath("document-delete-confirmation.png") });
  await page.route(`**/api/documents/${ids[0]}`, async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Удаление временно недоступно" }),
      });
    } else await route.continue();
  });
  await confirm(0).click();
  await expect(page.getByRole("alert")).toContainText(
    "Удаление временно недоступно",
  );
  await expect(remove(0)).toBeEnabled();
  expect(deleted).toEqual([`/api/documents/${ids[0]}`]);
  await page.unroute(`**/api/documents/${ids[0]}`);
  await remove(0).click();
  await expect(confirm(0)).toBeVisible();
  expect(deleted).toHaveLength(1);
  await confirm(0).click();
  await expect(
    page.locator(".document-item").filter({ hasText: titles[0] }),
  ).toHaveCount(0);
  expect(
    (await page.request.get(`/api/documents/${ids[0]}/file`)).status(),
  ).toBe(404);
  expect(
    (await page.request.get(`/api/documents/${ids[1]}/file`)).status(),
  ).toBe(200);
  if (info.project.name === "mobile") {
    await remove(1).tap();
    await expect(confirm(1)).toBeVisible();
    expect(deleted).toHaveLength(2);
    await confirm(1).tap();
  } else {
    await remove(1).focus();
    await remove(1).press("Enter");
    await expect(confirm(1)).toBeVisible();
    expect(deleted).toHaveLength(2);
    await confirm(1).press("Enter");
  }
  await expect(
    page.locator(".document-item").filter({ hasText: titles[1] }),
  ).toHaveCount(0);
  expect(deleted).toEqual([
    `/api/documents/${ids[0]}`,
    `/api/documents/${ids[0]}`,
    `/api/documents/${ids[1]}`,
  ]);
  expect(dialogs).toBe(0);
});

test("comment deletion needs confirmation and Escape keeps the reader open", async ({
  page,
}, info) => {
  const title = `Удаление комментариев ${info.project.name} ${info.retry}`;
  const upload = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title, personIds: [] }),
      ),
    },
    data: await samplePdf(),
  });
  expect(upload.status()).toBe(201);
  const { id } = await upload.json();
  const path = `/api/documents/${id}/annotations`;
  for (const text of ["Первый комментарий", "Второй комментарий"]) {
    const response = await page.request.post(path, {
      data: {
        page: 1,
        x: 0.1,
        y: text.startsWith("Первый") ? 0.2 : 0.5,
        width: 0.3,
        height: 0.1,
        text,
      },
    });
    expect(response.status()).toBe(201);
  }
  await page.goto(`/documents/${id}`);
  const reader = page.getByRole("dialog", { name: `Документ: ${title}` });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  const toggle = book.getByRole("button", { name: "Комментарии" });
  await toggle.click();
  await expect(book.locator(".drevo-page-mark")).toHaveCount(2);
  await page.clock.install();
  const deleted: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "DELETE")
      deleted.push(new URL(request.url()).pathname);
  });
  const first = reader
    .locator(".pdf-book-comments-list article")
    .filter({ hasText: "Первый комментарий" });
  const last = reader
    .locator(".pdf-book-comments-list article")
    .filter({ hasText: "Второй комментарий" });
  const remove = (card: typeof first) =>
    card.getByRole("button", {
      name: "Удалить комментарий на странице 1",
      exact: true,
    });
  const confirm = (card: typeof first) =>
    card.getByRole("button", {
      name: "Подтвердить удаление комментария на странице 1",
      exact: true,
    });
  // Keep the author line close to wrapping, as fonts differ between platforms.
  const sidebarWidth = await first.locator("small").evaluate(async (node) => {
    await document.fonts.ready;
    const context = document.createElement("canvas").getContext("2d")!;
    context.font = getComputedStyle(node).font;
    return (
      Math.ceil(context.measureText(node.textContent || "").width) + 18 + 79
    );
  });
  await reader.locator(".pdf-book-sidebar").evaluate((node, width) => {
    (node as HTMLElement).style.width = `${width}px`;
    (node as HTMLElement).style.flexBasis = `${width}px`;
  }, sidebarWidth);
  const nextButtonY = (await remove(last).boundingBox())!.y;
  await remove(first).click();
  await expect(confirm(first)).toHaveText("Удалить?");
  expect((await remove(last).boundingBox())!.y).toBe(nextButtonY);
  expect((await (await page.request.get(path)).json()).items).toHaveLength(2);
  expect(deleted).toEqual([]);
  await confirm(first).press("Escape");
  await expect(reader).toBeVisible();
  await expect(remove(first)).toBeVisible();
  expect((await remove(last).boundingBox())!.y).toBe(nextButtonY);
  await remove(first).dblclick();
  await expect(confirm(first)).toBeVisible();
  expect(deleted).toEqual([]);
  await last.locator("button").first().click();
  await expect(remove(first)).toBeVisible();
  await remove(first).click();
  await remove(last).click();
  await expect(remove(first)).toBeVisible();
  await expect(confirm(last)).toBeVisible();
  await confirm(last).press("Tab");
  await expect(remove(last)).toBeVisible();
  await remove(last).click();
  await page.clock.fastForward(8001);
  await expect(remove(last)).toBeVisible();
  await remove(first).click();
  await toggle.click();
  await expect(reader.locator(".pdf-book-sidebar")).toBeHidden();
  await toggle.click();
  await expect(remove(first)).toBeVisible();
  await remove(first).focus();
  await page.keyboard.down("Enter");
  await expect(confirm(first)).toBeVisible();
  await page.keyboard.down("Enter");
  await page.keyboard.up("Enter");
  await expect(confirm(first)).toBeVisible();
  expect(deleted).toEqual([]);
  await confirm(first).press("Escape");
  await remove(first).click();
  await reader
    .locator(".pdf-book-sidebar")
    .screenshot({ path: info.outputPath("comment-delete-confirmation.png") });
  await confirm(first).click();
  await expect(first).toHaveCount(0);
  await expect(last).toBeVisible();
  await expect(book.locator(".drevo-page-mark")).toHaveCount(1);
  await expect(reader.locator(".pdf-book-sidebar")).toBeVisible();
  expect(deleted).toHaveLength(1);
  const remaining = (await (await page.request.get(path)).json()).items;
  expect(remaining.map((item: { text: string }) => item.text)).toEqual([
    "Второй комментарий",
  ]);
});
