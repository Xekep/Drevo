import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";

async function openRegisterExport(page: Page) {
  // The context menu ignores right clicks while layout or camera setup is busy.
  // Checking only CSS motion classes can race the first layout on slower CI runners.
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).toHaveAttribute("data-camera-ready", "true");
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
  await page
    .locator(".react-flow__pane")
    .click({ button: "right", position: { x: 40, y: 350 } });
  await page.getByRole("menuitem", { name: "Экспорт древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Экспорт древа" });
  await dialog
    .getByRole("combobox", { name: "Формат экспорта" })
    .selectOption("generation-text");
  await dialog.getByRole("combobox", { name: "Родоначальник" }).selectOption("e2e-memorial-person");
  return dialog;
}

test.beforeEach(async ({ page, isMobile }) => {
  test.skip(
    isMobile,
    "Экспорт через контекстное меню полотна доступен на десктопе",
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
});

test("TXT downloads d’Aboville descendants including collapsed branches", async ({
  page,
}, info) => {
  let fullReads = 0;
  await page.route("**/api/family", async (route) => {
    fullReads++;
    const response = await route.fetch();
    const data = await response.json();
    const person = data.family.people.find(
      (entry: { id: string }) => entry.id === "e2e-child",
    );
    person.biography = "Биография из полной карточки\nВторая строка";
    person.needsReview = true;
    person.sources = [
      {
        title: "Метрическая книга",
        type: "архив",
        reference: "Ф. 12. Оп. 3. Д. 4. Л. 5.",
      },
    ];
    await route.fulfill({ response, json: data });
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
  const dialog = await openRegisterExport(page);
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  const download = await pending;
  expect(download.suggestedFilename()).toMatch(/^Поколенная роспись.*\.txt$/);
  const path = info.outputPath("visible-register.txt");
  await download.saveAs(path);
  const bytes = await readFile(path);
  expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  const text = bytes.toString("utf8");
  expect(text).toContain("ПОКОЛЕННАЯ РОСПИСЬ");
  expect(text).toMatch(/Поколение I\r\n/);
  expect(text).toMatch(/Поколение II\r\n/);
  expect(text).toContain("Биография из полной карточки\r\n      Вторая строка");
  expect(text).toContain("Данные требуют проверки");
  expect(text).toContain("Ф. 12. Оп. 3. Д. 4. Л. 5.");
  expect(text).toMatch(/^1\.1\. .*Пётр/m);
  expect(text).toMatch(/^1\.1\.1\. .*Анна/m);
  expect(text).toContain("* 01.01.1940");
  expect(text).toContain("+ 01.01.2020");
  expect(text).toContain("Анна");
  expect(fullReads).toBe(1);
  await page.screenshot({ path: info.outputPath("daboville-export.png") });
  await expect(dialog.getByRole("alert")).toHaveCount(0);
});

test("a changed permission scope stops TXT export instead of silently omitting people", async ({
  page,
}) => {
  await page.route("**/api/family", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.family.people = [];
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const dialog = await openRegisterExport(page);
  let downloaded = false;
  page.on("download", () => {
    downloaded = true;
  });
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    /Состав или доступ к древу изменился/,
  );
  await expect(
    dialog.getByRole("button", { name: "Скачать", exact: true }),
  ).toBeEnabled();
  expect(downloaded).toBe(false);
});

test("shared TXT export reads only the shared endpoint and rejects a revoked link", async ({
  page,
}, info) => {
  const archive = await (await page.request.get("/api/family")).json();
  const created = await page.request.post("/api/shares", {
    headers: {
      Origin: new URL(test.info().project.use.baseURL!).origin,
      "If-Match": String(archive.revision),
    },
    data: {
      title: "Роспись общей ветви",
      anchorId: "e2e-memorial-person",
      personIds: ["e2e-memorial-person", "e2e-child"],
      durationHours: 1,
    },
  });
  expect(created.status()).toBe(201);
  const share = await created.json();
  const apiPath = share.path.replace("/s/", "/api/shared/");
  let sharedReads = 0;
  let revoked = false;
  let archiveReads = 0;
  await page.route(`**${apiPath}`, async (route) => {
    sharedReads++;
    if (revoked)
      return route.fulfill({ status: 410, json: { error: "Ссылка отозвана" } });
    return route.continue();
  });
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/family") archiveReads++;
  });
  await page.goto(share.path);
  const dialog = await openRegisterExport(page);
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  const download = await pending;
  const path = info.outputPath("shared-register.txt");
  await download.saveAs(path);
  const text = await readFile(path, "utf8");
  expect(text).toContain("Людей: 2.");
  expect(text).toContain("Пётр");
  expect(text).not.toContain("Анна");
  expect(archiveReads).toBe(0);
  expect(sharedReads).toBeGreaterThanOrEqual(2);
  revoked = true;
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText(
    /Проверьте доступ к древу/,
  );
});


test("TXT requires a root and changing it excludes ancestors and unrelated branches", async ({ page }, info) => {
  await page.goto("/tree");
  const dialog = await openRegisterExport(page);
  const root = dialog.getByRole("combobox", { name: "Родоначальник" });
  await root.selectOption("");
  await expect(dialog.getByRole("button", { name: "Скачать", exact: true })).toBeDisabled();
  await root.selectOption("e2e-child");
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  const download = await pending;
  const path = info.outputPath("child-register.txt");
  await download.saveAs(path);
  const text = await readFile(path, "utf8");
  expect(text).toMatch(/^1\. Тестов Пётр Иванович/m);
  expect(text).toMatch(/^1\.1\. Тестова Анна Петровна/m);
  expect(text).not.toMatch(/^1(?:\.\d+)*\. .*Иван Петрович/m);
  expect(text).not.toContain("Мария");
  expect(text).toContain("Елена");
});

test("numbering selector downloads the traditional register without explanations in the form", async ({ page }, info) => {
  await page.goto("/tree");
  const dialog = await openRegisterExport(page);
  const selector = dialog.getByRole("combobox", { name: "Нумерация", exact: true });
  await expect(selector).toHaveValue("daboville");
  await selector.selectOption("person-parent");
  await expect(dialog).not.toContainText("номер человека.номер родителя");
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Скачать", exact: true }).click();
  const download = await pending;
  const path = info.outputPath("traditional-register.txt");
  await download.saveAs(path);
  const text = await readFile(path, "utf8");
  expect(text).toContain("Российская традиционная нумерация");
  expect(text).toMatch(/^2\.1\. Тестов Пётр Иванович/m);
  expect(text).toMatch(/^4\.2\. Тестова Анна Петровна/m);
  expect(text).not.toMatch(/^1\.1\.1\./m);
});
