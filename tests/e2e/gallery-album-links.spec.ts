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

test("предзагруженные фото перелистываются без вспышки индикатора загрузки", async ({
  page,
}) => {
  await page.goto("/photos/album-child-1990");
  const current = page.locator(".photo-slide-current .tag-image > img");
  const neighbors = page.locator(".photo-slide-neighbor img");
  await expect
    .poll(() =>
      current.evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
    )
    .toBe(true);
  await expect
    .poll(() =>
      neighbors.evaluateAll(
        (images) =>
          images.length > 0 &&
          images.every(
            (image) =>
              (image as HTMLImageElement).complete &&
              (image as HTMLImageElement).naturalWidth > 0,
          ),
      ),
    )
    .toBe(true);
  await expect(page.locator(".photo-load-status")).toHaveCount(0);
  await page.evaluate(() => {
    const flashes: string[] = [];
    Object.assign(window, { photoLoadingFlashes: flashes });
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const status = node.matches(".photo-load-status")
            ? node
            : node.querySelector(".photo-load-status");
          if (status) flashes.push(status.textContent || "");
        }
      }
    }).observe(document.querySelector(".photo-lightbox")!, {
      childList: true,
      subtree: true,
    });
  });
  for (let turn = 0; turn < 4; turn++) {
    const forward = turn % 2 === 0;
    await page
      .getByRole("button", {
        name: forward ? "Следующая фотография" : "Предыдущая фотография",
      })
      .click();
    await expect(page).toHaveURL(
      new RegExp(`/photos/album-child-${forward ? "1980" : "1990"}$`),
    );
    await expect
      .poll(() =>
        current.evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { photoLoadingFlashes: string[] })
            .photoLoadingFlashes,
      ),
    ).toEqual([]);
  }
});

test("медленная загрузка показывает статус, а ошибку снимка можно повторить", async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  await page.route(
    "**/media/album-child-1990.png?variant=display",
    async (route) => {
      if (fail) {
        await pending;
        await route.fulfill({ status: 503, body: "Недоступно" });
      } else {
        await route.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"><rect width="600" height="400" fill="#738273"/></svg>',
        });
      }
    },
  );
  await page.goto("/photos/album-child-1990");
  const status = page.locator(".photo-load-status");
  await expect(status).toHaveText("Загружаем фотографию…");
  await expect(status).toBeVisible();
  release();
  await expect(status).toContainText("Не удалось загрузить снимок.");
  fail = false;
  await status.getByRole("button", { name: "Повторить" }).click();
  await expect(status).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".photo-slide-current .tag-image > img")
        .evaluate(
          (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
        ),
    )
    .toBe(true);
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
    .locator(".photo-albums a")
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
    .locator(".photo-albums a")
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
    .locator(".photo-albums a")
    .filter({ hasText: "2000" })
    .click();
  await expect(page).toHaveURL(/\/photos\?year=2000$/);
  await page.reload();
  await expect(page.locator(".photo-grid .photo-tile")).toHaveCount(1);
});
