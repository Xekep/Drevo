import { expect, test } from "@playwright/test";
import { pagedPhotoFixture } from "./paged-photo-fixture";

test("reading a discussion skips CodeMirror; typing during its first download keeps text and caret", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  let started = false,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/assets/comment-editor-*.js", async (route) => {
    started = true;
    await gate;
    await route.continue();
  });
  try {
    await page.goto("/people/e2e-child");
    await page.getByRole("tab", { name: "Обсуждение" }).click();
    const field = page.getByRole("textbox", {
      name: "Сообщение для обсуждения",
    });
    await expect(field).toBeVisible();
    expect(started).toBe(false);
    expect(await field.evaluate((node) => node.tagName)).toBe("TEXTAREA");
    await field.fill("Семейное воспоминание");
    await expect.poll(() => started).toBe(true);
    release();
    await expect(page.locator(".comment-editor .cm-content")).toBeVisible();
    await expect(field).toContainText("Семейное воспоминание");
    await page.keyboard.insertText("!");
    await expect(field).toContainText("Семейное воспоминание!");
  } finally {
    release();
  }
});

test("insights and places use compact projections instead of full collection hydration", async ({
  page,
}) => {
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/family?")) requests.push(request.url());
  });
  await page.route("**/api/places/locate?**", (route) =>
    route.fulfill({ json: { candidates: [] } }),
  );
  await page.goto("/insights");
  await expect(page.locator(".insights-page")).toBeVisible();
  expect(requests.some((url) => url.includes("projection=insights"))).toBe(
    true,
  );
  expect(requests.some((url) => url.includes("projection=page"))).toBe(false);
  await page.goto("/places");
  await expect(page.locator(".places-content")).toBeVisible();
  expect(requests.some((url) => url.includes("projection=places"))).toBe(true);
  expect(requests.some((url) => url.includes("projection=page"))).toBe(false);
});

test("paged albums keep the full viewer sequence without loading the entire collection", async ({
  page,
}) => {
  const photos = Array.from({ length: 75 }, (_, index) => ({
    id: `paged-photo-${index}`,
    title: `Кадр ${index}`,
    url: `/media/paged-${index}.png`,
    year: "1950",
    tags: [
      {
        id: `tag-${index}`,
        personId: "e2e-child",
        x: 0,
        y: 0,
        width: 1,
        height: 1,
      },
    ],
  }));
  await pagedPhotoFixture(page, photos);
  await page.route("**/media/paged-*.png**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"/>',
    }),
  );
  const pages: number[] = [],
    fullCollections: string[] = [];
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.searchParams.get("projection") === "gallery")
      pages.push(Number(url.searchParams.get("offset")));
    if (url.searchParams.get("projection") === "page")
      fullCollections.push(response.url());
  });
  await page.goto("/photos?personId=e2e-child");
  await expect(page.locator(".photo-tile")).toHaveCount(30);
  await page.locator(".photo-tile").first().click();
  await expect(page.locator(".photo-counter")).toHaveText("1 / 75");
  await page.getByRole("button", { name: "Следующая фотография" }).click();
  await expect(page.locator(".photo-counter")).toHaveText("2 / 75");
  await expect(page).toHaveURL(/\/photos\/paged-photo-73$/);
  await page.getByRole("button", { name: "Закрыть просмотр фото" }).click();
  await page.locator(".load-more").scrollIntoViewIfNeeded();
  await expect(page.locator(".photo-tile")).toHaveCount(60);
  expect(pages).toContain(30);
  expect(fullCollections).toEqual([]);
});
