import { expect, test } from "@playwright/test";

test("ссылка на человека открывает карточку и работает с историей браузера", async ({
  page,
}, testInfo) => {
  await page.goto("/tree?person=e2e-memorial-person");
  await expect(page.locator(".inspector-dock .profile-head")).toBeVisible();
  await expect(
    page
      .locator(".inspector-dock")
      .getByRole("button", { name: "Скопировать ссылку" }),
  ).toBeVisible();

  if (testInfo.project.name === "desktop") {
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page
      .locator(".inspector-dock")
      .getByRole("button", { name: "Скопировать ссылку" })
      .click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      "http://127.0.0.1:4173/tree?person=e2e-memorial-person",
    );
  }

  await page
    .locator(".inspector-dock")
    .getByRole("button", { name: "Закрыть панель" })
    .click();
  await expect(page).toHaveURL("http://127.0.0.1:4173/tree");
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
});

test("выбор человека записывается в адрес и восстанавливается кнопками браузера", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-memorial-person")
    .locator(".flow-person-content")
    .click();
  await expect(page).toHaveURL(/\/tree\?person=e2e-memorial-person$/);
  await page.goBack();
  await expect(page).toHaveURL("http://127.0.0.1:4173/tree");
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
  await page.goForward();
  await expect(page.locator(".inspector-dock .profile-head")).toBeVisible();
  await page.reload();
  await expect(page.locator(".inspector-dock .profile-head")).toBeVisible();
  await page.locator(".inspector-person-actions .person-expand-button").click();
  await page
    .locator(".person-full-dialog")
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await expect(page).toHaveURL(/\/tree\?person=e2e-child$/);
  await page
    .locator(".person-full-dialog")
    .getByRole("button", { name: "Скопировать ссылку" })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "http://127.0.0.1:4173/tree?person=e2e-child",
  );
});

test("ссылка на снимок открывает просмотр и закрывается без потери маршрута", async ({
  page,
}) => {
  const photo = {
    id: "e2e-photo",
    url: "/media/e2e-photo.png",
    title: "Проверочный снимок",
    tags: [],
  };
  const nextPhoto = {
    ...photo,
    id: "e2e-photo-next",
    url: "/media/e2e-photo-next.png",
  };
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.totals.photos = 2;
    await route.fulfill({ response, json: data });
  });
  await page.route(
    "**/api/family?projection=page&collection=photos&**",
    (route) => {
      const token = new URL(route.request().url()).searchParams.get("token");
      return route.fulfill({
        json: { pageToken: token, total: 2, items: [photo, nextPhoto] },
      });
    },
  );
  await page.route("**/media/e2e-photo*.png**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
        "base64",
      ),
    }),
  );
  await page.goto("/photos?photo=e2e-photo");
  await page.locator(".photo-previous").click();
  await expect(page).toHaveURL(
    "http://127.0.0.1:4173/photos?photo=e2e-photo-next",
  );
  await expect(
    page.getByRole("dialog", { name: /Просмотр фото/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Скопировать ссылку" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Закрыть просмотр фото" }).click();
  await expect(page).toHaveURL("http://127.0.0.1:4173/photos");
  await expect(page.getByRole("dialog", { name: /Просмотр фото/ })).toHaveCount(
    0,
  );
});
