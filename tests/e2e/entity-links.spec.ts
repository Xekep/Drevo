import { expect, test } from "@playwright/test";

test("ссылка на человека открывает карточку и работает с историей браузера", async ({
  page,
}, testInfo) => {
  await page.goto("/tree?person=e2e-memorial-person");
  await expect(page).toHaveURL(
    "http://127.0.0.1:4173/people/e2e-memorial-person",
  );
  await expect(page.locator(".inspector-dock .profile-head")).toBeVisible();
  await page.goto("/people/e2e-memorial-person");
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
      "http://127.0.0.1:4173/people/e2e-memorial-person",
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
  await expect(page).toHaveURL(/\/people\/e2e-memorial-person$/);
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
  await expect(page).toHaveURL(/\/people\/e2e-child$/);
  await page
    .locator(".person-full-dialog")
    .getByRole("button", { name: "Скопировать ссылку" })
    .click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    "http://127.0.0.1:4173/people/e2e-child",
  );
});

test("переход из снимка перестраивает открытый веер вокруг человека", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.totals.photos = 1;
    await route.fulfill({ response, json: data });
  });
  await page.route(
    "**/api/family?projection=page&collection=photos&**",
    (route) => {
      const token = new URL(route.request().url()).searchParams.get("token");
      return route.fulfill({
        json: {
          pageToken: token,
          total: 1,
          items: [
            {
              id: "e2e-fan-photo",
              url: "/media/e2e-fan-photo.png",
              title: "Семейный снимок",
              tags: [
                {
                  id: "e2e-fan-tag",
                  personId: "e2e-memorial-person",
                  x: 0.3,
                  y: 0.2,
                  width: 0.25,
                  height: 0.4,
                },
              ],
            },
          ],
        },
      });
    },
  );
  await page.route("**/media/e2e-fan-photo.png**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"/>',
    }),
  );

  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Веер" }).click();
  const fan = page.locator(".fan-chart");
  await expect(fan).toHaveAttribute("aria-label", /Пётр/);

  await page.locator(".archive-nav .nav-sections").getByRole("link", { name: "Фото" }).click();
  await page.locator(".photo-tile").first().click();
  await page.getByRole("button", { name: /Показать сведения:.*Иван/ }).click();
  await page.getByRole("button", { name: "Показать в древе" }).click();

  await expect(page).toHaveURL(/\/people\/e2e-memorial-person$/);
  await expect(fan).toBeVisible();
  await expect(fan).toHaveAttribute("aria-label", /Иван/);
});

test("ссылка на снимок открывает просмотр и закрывается без потери маршрута", async ({
  page,
}, testInfo) => {
  const photo = {
    id: "e2e-photo",
    url: "/media/e2e-photo.png",
    title: "Проверочный снимок",
    tags: [
      {
        id: "e2e-face-tag",
        personId: "e2e-memorial-person",
        x: 0.3,
        y: 0.2,
        width: 0.25,
        height: 0.4,
      },
    ],
  };
  const nextPhoto = {
    ...photo,
    id: "e2e-photo-next",
    url: "/media/e2e-photo-next.png",
    tags: [],
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
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#82947e"/></svg>',
    }),
  );
  await page.goto("/photos?photo=e2e-photo");
  await expect(page).toHaveURL("http://127.0.0.1:4173/photos/e2e-photo");
  await page.goto("/photos/e2e-photo");
  if (testInfo.project.name === "desktop") {
    const stageBefore = await page.locator(".photo-stage").boundingBox(),
      informationBefore = await page
        .locator("#photo-information")
        .boundingBox();
    expect(stageBefore).not.toBeNull();
    expect(informationBefore).not.toBeNull();
    await page
      .getByRole("button", { name: /Показать сведения:.*Иван/ })
      .click();
    const stageAfter = await page.locator(".photo-stage").boundingBox(),
      personSidebar = await page.locator(".photo-person-sidebar").boundingBox();
    expect(stageAfter).not.toBeNull();
    expect(personSidebar).not.toBeNull();
    expect(Math.abs(stageAfter!.width - stageBefore!.width)).toBeLessThan(1);
    expect(
      Math.abs(personSidebar!.width - informationBefore!.width),
    ).toBeLessThan(1);
  } else {
    await page.locator(".tag-image img").tap({ position: { x: 20, y: 20 } });
    await expect(page.locator(".photo-viewer")).toHaveClass(/show-tags/);
    await page
      .getByRole("button", { name: /Показать сведения:.*Иван/ })
      .click();
  }
  await expect(
    page.locator(".photo-person-sidebar .profile-head"),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Закрыть сведения о человеке" }),
  ).toHaveCount(0);
  const toolbarButtons = [
    page.locator(".photo-person-sidebar").getByRole("button", { name: "О снимке" }),
    page.getByRole("button", { name: "Показать в древе" }),
    page.getByRole("button", { name: "Скопировать ссылку" }),
    page.getByRole("button", { name: "Закрыть просмотр фото" }),
  ];
  const positions = await Promise.all(toolbarButtons.map((button) => button.boundingBox()));
  expect(positions.every(Boolean)).toBe(true);
  expect(Math.max(...positions.map((box) => box!.y)) - Math.min(...positions.map((box) => box!.y))).toBeLessThan(2);
  await expect(page).toHaveURL("http://127.0.0.1:4173/photos/e2e-photo");
  await page
    .locator(".photo-person-sidebar")
    .getByRole("button", { name: "О снимке" })
    .click();
  await expect(page.locator("#photo-information")).toBeVisible();
  await page.locator(".photo-people-names .photo-person-name").click();
  await page.getByRole("button", { name: "Показать в древе" }).click();
  await expect(page).toHaveURL(
    "http://127.0.0.1:4173/people/e2e-memorial-person",
  );
  await page.goBack();
  await expect(
    page.getByRole("dialog", { name: /Просмотр фото/ }),
  ).toBeVisible();
  await expect(page).toHaveURL("http://127.0.0.1:4173/photos/e2e-photo");
  if (testInfo.project.name === "desktop") {
    await page
      .getByRole("button", { name: /Показать сведения:.*Иван/ })
      .dblclick();
    await expect(page).toHaveURL(
      "http://127.0.0.1:4173/people/e2e-memorial-person",
    );
    await page.goBack();
    await expect(
      page.getByRole("dialog", { name: /Просмотр фото/ }),
    ).toBeVisible();
  }
  await page.locator(".photo-previous").click();
  await expect(page).toHaveURL("http://127.0.0.1:4173/photos/e2e-photo-next");
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
