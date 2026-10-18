import { expect, test } from "@playwright/test";

test("compact document rows retain titles, metadata and edit controls at narrow widths", async ({
  page,
  isMobile,
}, info) => {
  await page.route("**/api/documents?*", (route) =>
    route.fulfill({
      json: {
        total: 6,
        items: Array.from({ length: 6 }, (_, index) => ({
          id: `minimal-document-${index}`,
          title:
            index % 2
              ? "Метрическая запись о рождении, 1887 год"
              : "Свидетельство о заключении брака Александра Петровича и Марии Ивановны",
          url: `/media/document-${index}.pdf`,
          size: 240_000,
          mimeType: index === 5 ? "image/tiff" : "application/pdf",
          createdAt: "2026-10-18T00:00:00Z",
          canDelete: true,
          documentType: "Метрическая запись",
          documentDate: "1887",
          people:
            index < 4
              ? [{ id: "e2e-child", name: "Тестов Пётр Иванович" }]
              : [],
          eventLinks: [],
          pages: [],
          sources: [],
        })),
      },
    }),
  );
  await page.goto("/documents");
  await expect(page.locator(".document-item")).toHaveCount(6);
  for (const width of isMobile ? [320, 390, 768] : [1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const first = page.locator(".document-item-row").first();
    const title = first.locator("strong");
    await expect(title).toContainText("Свидетельство о заключении брака");
    await expect(first.locator(".document-format")).toHaveText("PDF");
    const item = (await first.boundingBox())!;
    expect(item.height).toBeLessThan(92);
    const edit = first.getByRole("button", { name: /Редактировать документ/ });
    await expect(edit).toBeVisible();
    await expect(
      first.getByRole("button", { name: /Удалить документ/ }),
    ).toBeVisible();
    const editBox = (await edit.boundingBox())!;
    const titleBox = (await title.boundingBox())!;
    expect(titleBox.x + titleBox.width).toBeLessThan(editBox.x);
    if (width === 390 || width === 1440)
      await page.screenshot({
        path: info.outputPath(`documents-${width}.png`),
      });
  }
  await page
    .locator(".document-item-row")
    .first()
    .getByRole("button", { name: /Редактировать документ/ })
    .click();
  await expect(
    page.locator(".documents-upload").getByLabel("Название", { exact: true }),
  ).toHaveValue(/Свидетельство о заключении брака/);
});
