import { expect, test } from "@playwright/test";

const photos = [
  {
    id: "album-child-1980",
    url: "/media/album-child-1980.png",
    title: "Снимок 1980",
    year: "1980",
    createdAt: "2026-01-01T00:00:00.000Z",
    tags: [
      {
        id: "album-tag-1",
        personId: "e2e-child",
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.3,
      },
    ],
  },
  {
    id: "album-child-1990",
    url: "/media/album-child-1990.png",
    title: "Снимок 1990",
    year: "1990",
    createdAt: "2026-02-01T00:00:00.000Z",
    tags: [
      {
        id: "album-tag-2",
        personId: "e2e-child",
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.3,
      },
    ],
  },
  {
    id: "album-spouse-2000",
    url: "/media/album-spouse-2000.png",
    title: "Снимок 2000",
    year: "2000",
    createdAt: "2026-03-01T00:00:00.000Z",
    tags: [
      {
        id: "album-tag-3",
        personId: "e2e-spouse",
        x: 0.1,
        y: 0.1,
        width: 0.3,
        height: 0.3,
      },
    ],
  },
];

test.beforeEach(async ({ page }) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.totals.photos = photos.length;
    await route.fulfill({ response, json: data });
  });
  await page.route(
    "**/api/family?projection=page&collection=photos&**",
    (route) =>
      route.fulfill({
        json: {
          pageToken: new URL(route.request().url()).searchParams.get("token"),
          total: photos.length,
          items: photos,
        },
      }),
  );
  await page.route("**/media/album-*.png**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" />',
    }),
  );
});

test("альбом человека сохраняет адрес и показывает только добавление и годы", async ({
  page,
}) => {
  await page.goto("/people/e2e-child");
  await page
    .getByRole("button", { name: /Открыть фотоальбом человека/ })
    .click();
  await expect(page).toHaveURL(/\/photos\?personId=e2e-child$/);
  await expect(
    page.getByRole("button", { name: "Все · по добавлению" }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "По людям" })).toHaveCount(0);
  await expect(page.locator(".photo-grid .photo-tile")).toHaveCount(2);

  await page.reload();
  await expect(page).toHaveURL(/\/photos\?personId=e2e-child$/);
  await expect(page.locator(".photo-grid .photo-tile")).toHaveCount(2);
  await expect(page.getByRole("button", { name: "По людям" })).toHaveCount(0);

  await page.getByRole("button", { name: "По годам" }).click();
  await page
    .locator(".photo-albums button")
    .filter({ hasText: "1980" })
    .click();
  await expect(page).toHaveURL(/\/photos\?personId=e2e-child&year=1980$/);
  await page.reload();
  await expect(page.locator(".photo-grid .photo-tile")).toHaveCount(1);
  await page.locator(".photo-grid .photo-tile").click();
  await expect(page).toHaveURL(/\/photos\/album-child-1980$/);
  await page.getByRole("button", { name: "Закрыть просмотр фото" }).click();
  await expect(page).toHaveURL(/\/photos\?personId=e2e-child&year=1980$/);
});

test("общая галерея открывает альбомы людей и годов по ссылкам", async ({
  page,
}) => {
  await page.goto("/photos");
  await expect(page.getByRole("button", { name: "По людям" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page
    .locator(".photo-albums button")
    .filter({ hasText: "Пётр" })
    .click();
  await expect(page).toHaveURL(/\/photos\?personId=e2e-child$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/photos$/);
  await expect(page.getByRole("button", { name: "По людям" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.goForward();
  await expect(page).toHaveURL(/\/photos\?personId=e2e-child$/);
  await page.getByRole("button", { name: "Показать все фотографии" }).click();
  await expect(page).toHaveURL(/\/photos$/);
  await expect(page.getByRole("button", { name: "По людям" })).toBeVisible();
  await page.getByRole("button", { name: "По годам" }).click();
  await page
    .locator(".photo-albums button")
    .filter({ hasText: "2000" })
    .click();
  await expect(page).toHaveURL(/\/photos\?year=2000$/);
  await page.reload();
  await expect(page.locator(".photo-grid .photo-tile")).toHaveCount(1);
});
