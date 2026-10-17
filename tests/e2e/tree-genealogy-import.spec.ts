import { expect, test } from "@playwright/test";
import { ZipFile } from "yazl";

test("one tree import picker routes genealogy by content and requires an explicit apply", async ({
  page,
  isMobile,
}, info) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  await page
    .locator(".react-flow__pane")
    .click({ button: "right", position: { x: 40, y: 350 } });
  await page.getByRole("menuitem", { name: "Импорт", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Импорт в древо" });
  if (isMobile) await page.setViewportSize({ width: 320, height: 900 });
  const gedcom = Buffer.from(
    "0 HEAD\n1 GEDC\n2 VERS 7.0\n0 @I1@ INDI\n1 NAME Предпросмотр /Переноса/\n1 SEX M\n0 TRLR\n",
  );
  const zip = new ZipFile();
  zip.addBuffer(gedcom, "gedcom.ged");
  const output = new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk) => chunks.push(chunk));
    zip.outputStream.on("error", reject);
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
  });
  zip.end();
  let previews = 0,
    writes = 0;
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (path === "/api/gedcom/preview") previews++;
    if (
      [
        "/api/gedcom/import",
        "/api/family/changes",
        "/api/import/additions/apply",
      ].includes(path)
    )
      writes++;
  });
  for (const [name, buffer, label] of [
    ["renamed.json", gedcom, "GEDCOM"],
    ["archive.gdz", await output, "GEDZIP"],
    [
      "renamed.ged",
      Buffer.from(
        '<agelongtree><persons><person id="p" fn="Анна" sn="Тестова" sex="Ж" bdate="1880"/></persons></agelongtree>',
      ),
      "XML «Древа Жизни»",
    ],
  ] as const) {
    await dialog
      .getByLabel("Файл для импорта")
      .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
    await expect(dialog.locator(".json-additions-filename")).toContainText(
      label,
    );
    await dialog
      .getByRole("button", { name: "Проверить файл", exact: true })
      .click();
    await expect(
      dialog.getByRole("button", { name: "Подтвердить добавление 1 человек" }),
    ).toBeVisible();
    expect(
      await dialog.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
  }
  expect(previews).toBe(3);
  expect(writes).toBe(0);
  await dialog.screenshot({
    path: info.outputPath("automatic-tree-import.png"),
  });
});
