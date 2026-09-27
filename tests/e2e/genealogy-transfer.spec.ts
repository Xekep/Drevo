import { test, expect } from "@playwright/test";

test("форматы экспорта и импорт GEDCOM с предпросмотром", async ({
  page,
}, testInfo) => {
  // The API transaction is covered by genealogy-transfer.test.ts. Isolate UI
  // previews so desktop/mobile workers do not replace one admin's stage.
  await page.route("**/api/gedcom/preview", async (route) => {
    expect(route.request().postData()).toContain("2 VERS 7.0.18");
    await route.fulfill({
      json: {
        token: "ui-preview",
        version: "7.0.18",
        people: 1,
        connections: 0,
        events: 0,
        photos: 0,
        documents: 0,
        warnings: [],
        warningCount: 0,
        possibleDuplicates: [],
        duplicateCount: 0,
        sample: [{ name: "Проверка Переноса", birth: "" }],
      },
    });
  });
  await page.route("**/api/gedcom/import", async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      token: "ui-preview",
      confirm: true,
    });
    await route.fulfill({ json: { added: 1, photos: 0, documents: 0 } });
  });
  await page.goto("/admin");
  await page
    .getByRole("button", { name: "Экспорт и импорт", exact: true })
    .click();
  const panel = page.locator(".gedcom-transfer");
  await expect(
    panel.getByRole("radio", { name: "GEDZIP 7", exact: true }),
  ).toBeChecked();
  const download = panel.getByRole("link", {
    name: "Скачать выбранный формат",
  });
  await expect(download).toHaveAttribute(
    "href",
    "/api/gedcom/export?format=gedzip7",
  );
  for (const [label, format] of [
    ["GEDCOM 5.5.1", "gedcom551"],
    ["GEDCOM 7", "gedcom7"],
    ["Drevo Archive", "drevoArchive"],
    ["XML «Древа Жизни 6»", "agelongXml"],
  ]) {
    await panel.getByRole("radio", { name: label, exact: true }).check();
    await expect(download).toHaveAttribute(
      "href",
      format === "drevoArchive"
        ? "/api/backup/full"
        : `/api/gedcom/export?format=${format === "agelongXml" ? "agelongZip" : format}`,
    );
  }
  await panel
    .getByRole("checkbox", { name: "Включить фото и PDF в ZIP вместе с XML" })
    .uncheck();
  await expect(download).toHaveAttribute(
    "href",
    "/api/gedcom/export?format=agelongXml",
  );
  const text =
    "0 HEAD\n1 GEDC\n2 VERS 7.0.18\n0 @I1@ INDI\n1 NAME Проверка /Переноса/\n0 TRLR\n";
  await panel.locator('input[type="file"]').setInputFiles({
    name: "example.ged",
    mimeType: "text/plain",
    buffer: Buffer.from(text),
  });
  await panel.getByRole("button", { name: "Проверить файл" }).click();
  await expect(panel.getByText("Формат: 7.0.18")).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Подтвердить добавление 1 человек" }),
  ).toBeVisible();
  await page.setViewportSize({
    width: testInfo.project.name === "mobile" ? 320 : 1280,
    height: 900,
  });
  expect(
    await panel.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await panel.screenshot({
    path: testInfo.outputPath("genealogy-transfer.png"),
  });
  await panel
    .getByRole("button", { name: "Подтвердить добавление 1 человек" })
    .click();
  await expect(panel.getByRole("status")).toContainText("Добавлено людей: 1");
});
