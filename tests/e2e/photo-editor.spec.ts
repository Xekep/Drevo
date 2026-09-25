import { expect, test } from "@playwright/test";

test("редактор фото сохраняет снимок видимым и отменяет черновик отметки", async ({
  page,
}, testInfo) => {
  const photo = {
    id: "e2e-editor-photo",
    title: "Проверочный снимок",
    url: "/media/e2e-editor-photo.png",
    year: "1965",
    tags: [
      {
        id: "existing-tag",
        personId: "e2e-memorial-person",
        x: 0.1,
        y: 0.1,
        width: 0.15,
        height: 0.2,
      },
    ],
  };
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.totals.photos = 1;
    await route.fulfill({ response, json: data });
  });
  await page.route(
    "**/api/family?projection=page&collection=photos&**",
    (route) => {
      const pageToken = new URL(route.request().url()).searchParams.get(
        "token",
      );
      return route.fulfill({ json: { pageToken, total: 1, items: [photo] } });
    },
  );
  await page.route("**/media/e2e-editor-photo.png**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="900" height="600"><rect width="900" height="600" fill="#738273"/><circle cx="450" cy="200" r="72" fill="#d2c8b3"/><path d="M300 510V370Q450 250 600 370V510" fill="#48594b"/></svg>',
    }),
  );
  await page.goto("/photos/e2e-editor-photo");
  const toolbar = page.getByRole("group", { name: "Действия с фотографией" });
  if (testInfo.project.name === "mobile") {
    await expect(toolbar).toBeVisible();
    await expect(
      toolbar.getByRole("button", { name: "Редактировать", exact: true }),
    ).toHaveCount(0);
    await expect(
      toolbar.getByRole("button", { name: "Скопировать ссылку" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "О снимке", exact: true }).click();
    await expect(page.locator("#photo-information")).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("photo-mobile-view.png"),
    });
    return;
  }
  const positions = await Promise.all(
    [
      toolbar.getByRole("button", { name: "Редактировать", exact: true }),
      toolbar.getByRole("button", { name: "Скопировать ссылку" }),
      toolbar.getByRole("button", { name: "Закрыть просмотр фото" }),
    ].map(async (button) => {
      await expect(button).toBeVisible();
      return button.boundingBox();
    }),
  );
  expect(
    Math.max(...positions.map((box) => box!.y)) -
      Math.min(...positions.map((box) => box!.y)),
  ).toBeLessThan(2);
  await toolbar
    .getByRole("button", { name: "Редактировать", exact: true })
    .click();
  await page.getByRole("button", { name: "Отметить вручную" }).click();
  await expect(page.locator(".draft-tag")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Кто это?" })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Найти лица", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText("Изменить описание фотографии", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Сохранить отметку" }),
  ).toBeDisabled();

  await page.getByText("Уточнить рамку", { exact: true }).click();
  await page.getByRole("slider", { name: "Слева" }).fill("0.4");
  expect(
    await page
      .locator(".draft-tag")
      .evaluate((node) => (node as HTMLElement).style.left),
  ).toBe("40%");
  await page.getByText("Уточнить рамку", { exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("photo-tag-editor.png") });

  await page.getByRole("button", { name: "Отменить отметку" }).click();
  await expect(page.locator(".draft-tag")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Найти лица", exact: true }),
  ).toBeVisible();
  await page.getByText("Изменить описание фотографии", { exact: true }).click();
  await page.getByRole("textbox", { name: "Год", exact: true }).fill("1970");
  page.once("dialog", (dialog) => dialog.dismiss());
  await toolbar
    .getByRole("button", { name: "Завершить редактирование" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Год", exact: true }),
  ).toHaveValue("1970");
  page.once("dialog", (dialog) => dialog.accept());
  await toolbar
    .getByRole("button", { name: "Завершить редактирование" })
    .click();
  await expect(
    toolbar.getByRole("button", { name: "Редактировать", exact: true }),
  ).toBeVisible();
});
