import { test, expect } from "@playwright/test";
import { openAdminSection } from "./admin-navigation";

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
  await openAdminSection(page, "data", "Экспорт и импорт");
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
  await expect(
    panel.getByRole("link", { name: "Экспорт JSON без фото" }),
  ).toHaveAttribute("href", "/api/export.json?download=1");
  for (const [label, format] of [
    ["GEDCOM 5.5.1", "gedcom551"],
    ["GEDCOM 7", "gedcom7"],
  ]) {
    await panel.getByRole("radio", { name: label, exact: true }).check();
    await expect(download).toHaveAttribute(
      "href",
      `/api/gedcom/export?format=${format}`,
    );
  }
  await expect(panel.getByRole("radio", { name: "Drevo Archive" })).toHaveCount(
    0,
  );
  await expect(
    panel.getByRole("radio", { name: "XML «Древа Жизни 6»" }),
  ).toHaveCount(0);
  const text =
    "0 HEAD\n1 GEDC\n2 VERS 7.0.18\n0 @I1@ INDI\n1 NAME Проверка /Переноса/\n0 TRLR\n";
  await panel
    .getByLabel("Файл GEDCOM, GEDZIP или XML «Древа Жизни 6»")
    .setInputFiles({
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
  await panel
    .getByText("Полная замена архива из JSON", { exact: true })
    .click();
  const jsonInput = panel.getByLabel("Выберите экспорт архива");
  if (testInfo.project.name === "mobile") {
    await expect(jsonInput).toBeDisabled();
  } else {
    await jsonInput.setInputFiles({
      name: "archive.json",
      mimeType: "application/json",
      buffer: Buffer.from(
        JSON.stringify({
          title: "Сохранённый архив",
          description: "",
          demo: false,
          people: [],
        }),
      ),
    });
    await expect(
      panel.getByText("«Сохранённый архив»: 0 человек, 0 фотографий."),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Заменить архив этими данными" }),
    ).toBeVisible();
  }
});
