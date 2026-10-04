import { expect } from "@playwright/test";
import PDFDocument from "pdfkit";
import { test } from "./fixtures/document-server";

test("document Markdown preserves lines, safe links and editing without breaking navigation", async ({
  page,
}, info) => {
  const pdf = new PDFDocument();
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const buffer = new Promise<Buffer>((resolve) =>
    pdf.on("end", () => resolve(Buffer.concat(chunks))),
  );
  pdf
    .text("First page")
    .addPage()
    .text("Second page")
    .addPage()
    .text("Third page");
  pdf.end();
  const upload = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: "Markdown", personIds: [] }),
      ),
    },
    data: await buffer,
  });
  expect(upload.status()).toBe(201);
  const { id } = await upload.json();
  const original =
    "**Выделение** и *курсив*\nСледующая строка\n\n- Первый пункт\n- Второй пункт\n\n> Цитата\n\n`код` и [ссылка](https://example.com/)\n\n```text\nстрока 1\nстрока 2\n```\n\n| Поле | Значение |\n| --- | --- |\n| Дата | 1887 |\n\n<script>window.markdownUnsafe = true</script>\n\n[Опасная ссылка](javascript:alert(1))";
  for (const [number, text] of [
    [1, "Начало"],
    [3, original],
  ] as const) {
    const response = await page.request.post(
      `/api/documents/${id}/annotations`,
      {
        data: { page: number, x: 0.1, y: 0.2, width: 0.3, height: 0.1, text },
      },
    );
    expect(response.status()).toBe(201);
  }
  await page.goto(`/documents/${id}`);
  const reader = page.getByRole("dialog", { name: "Документ: Markdown" });
  const book = reader.frameLocator("iframe.pdf-book-frame");
  const toggle = book.locator(".drevo-toolbar-comments");
  await toggle.click();
  const card = reader.locator(".pdf-book-comments-list article").last();
  const content = card.locator(".pdf-book-comment-text");
  await expect(content.locator("strong")).toHaveText("Выделение");
  await expect(content.locator("em")).toHaveText("курсив");
  await expect(content.locator("li")).toHaveCount(2);
  await expect(content.locator("ul")).toHaveCSS("list-style-type", "disc");
  await expect(content.locator("blockquote")).toContainText("Цитата");
  await expect(content.locator("pre code")).toHaveText("строка 1\nстрока 2\n");
  await expect(content.locator("table")).toContainText("1887");
  const paragraph = content.locator("p").first();
  await expect(paragraph).toHaveCSS("white-space", "pre-wrap");
  expect(await paragraph.textContent()).toBe(
    "Выделение и курсив\nСледующая строка",
  );
  const lines = await paragraph.evaluate((node) => {
    const text = node.lastChild!;
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent!.length);
    return [...range.getClientRects()].map((rect) => rect.y);
  });
  expect(new Set(lines).size).toBeGreaterThan(1);
  await expect(
    content.locator("script, [onerror], a[href^='javascript:']"),
  ).toHaveCount(0);
  await expect(card.locator("button a, button p")).toHaveCount(0);
  const link = content.getByRole("link", { name: "ссылка", exact: true });
  await expect(link).toHaveAttribute("target", "_blank");
  await page.context().route("https://example.com/**", (route) =>
    route.fulfill({ body: "External link" }),
  );
  const popup = page.context().waitForEvent("page");
  await link.click();
  await (await popup).close();
  await expect(card.locator("button").first()).toHaveAttribute(
    "aria-pressed",
    "false",
  );
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await paragraph.click();
  await expect(card).toHaveClass("is-active");
  await expect(
    book.locator('.BRpage-visible[data-index="2"] .drevo-page-mark.is-active'),
  ).toHaveCount(1);
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(book.locator('.BRpage-visible[data-index="0"]')).toBeHidden();
  await reader.screenshot({ path: info.outputPath("document-markdown.png") });
  await card
    .getByRole("button", { name: "Изменить комментарий на странице 3" })
    .click();
  const editor = card.getByRole("textbox", { name: "Изменить комментарий" });
  await expect(editor).toHaveValue(original);
  const edited = "**Обновлено**\nВторая строка\n\nНовый абзац";
  await editor.fill(edited);
  await card.getByRole("button", { name: "Сохранить", exact: true }).click();
  await expect(content.locator("strong")).toHaveText("Обновлено");
  await expect(content.locator("p")).toHaveCount(2);
  await page.reload();
  await toggle.click();
  await expect(content.locator("p").first()).toHaveText(
    "Обновлено\nВторая строка",
  );
  const stored = await (
    await page.request.get(`/api/documents/${id}/annotations`)
  ).json();
  expect(stored.items.at(-1).text).toBe(edited);
});
