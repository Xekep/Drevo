import { expect, test, type Locator, type Page } from "@playwright/test";

async function touchGesture(page: Page, target: Locator, dy: number, hold = 0) {
  const box = await target.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + Math.min(28, box!.height / 2);
  const session = await page.context().newCDPSession(page);
  const point = (offset: number) => [{ x, y: y + offset }];
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: point(0),
  });
  if (hold) await page.waitForTimeout(hold);
  if (dy) {
    for (const offset of [dy / 3, (dy * 2) / 3, dy]) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: point(offset),
      });
      await page.waitForTimeout(25);
    }
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
}

test("mobile fan starts centered", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Веер", exact: true }).evaluate((button: HTMLButtonElement) => button.click());
  const fan = page.locator(".fan-chart");
  await expect(fan).toBeVisible();
  await expect
    .poll(() =>
      fan.evaluate((element) =>
        Math.abs(
          element.scrollLeft -
            (element.scrollWidth - element.clientWidth) / 2,
        ),
      ),
    )
    .toBeLessThan(2);
});

test("long press selects a card without opening a profile or relationship mode", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/tree");
  await touchGesture(
    page,
    page.getByTestId("rf__node-e2e-child").locator(".flow-person-content"),
    0,
    650,
  );
  const dock = page.locator(".inspector-dock");
  await expect(page.getByTestId("rf__node-e2e-child").locator(".flow-person")).toHaveClass(/is-selected/);
  await expect(dock).toHaveCount(0);
  await expect(page).toHaveURL(/\/tree$/);
  await expect(page.getByRole("button", { name: "Родство", exact: true })).not.toHaveClass(/active/);
  await page.getByTestId("rf__node-e2e-child").locator(".flow-person-content").tap();
  await expect(dock).toBeVisible();
  await expect(dock.locator(".comparison-content")).toHaveCount(0);
  await expect(page).toHaveURL(/\/people\/e2e-child$/);
  await dock.getByRole("button", { name: "Свернуть панель" }).click();
  await touchGesture(page, page.getByTestId("rf__node-e2e-child").locator(".flow-person-content"), 0, 650);
  await expect(dock).toHaveCount(0);
  await expect(page).toHaveURL(/\/tree$/);
});

test("downward swipes dismiss mobile photo details and a person's card", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  const photo = {
    id: "e2e-mobile-photo",
    url: "/media/e2e-mobile-photo.png",
    title: "Семейный снимок",
    tags: [
      {
        id: "e2e-mobile-tag",
        personId: "e2e-memorial-person",
        x: 0.3,
        y: 0.2,
        width: 0.25,
        height: 0.4,
      },
    ],
  };
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.totals.photos = 1;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/family?projection=page&collection=photos&**", (route) => {
    const token = new URL(route.request().url()).searchParams.get("token");
    return route.fulfill({ json: { pageToken: token, total: 1, items: [photo] } });
  });
  await page.route("**/media/e2e-mobile-photo.png**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400"/>',
    }),
  );
  await page.goto("/photos/e2e-mobile-photo");
  await page.locator(".photo-info-toggle").click();
  const info = page.locator("#photo-information");
  await expect(info).toBeVisible();
  await touchGesture(page, info, 110);
  await expect(info).toBeHidden();

  await page.locator(".tag-image img").tap({ position: { x: 20, y: 20 } });
  await page.getByRole("button", { name: /Показать сведения:.*Иван/ }).click();
  const person = page.locator(".photo-person-sidebar");
  await expect(person).toBeVisible();
  await expect(info).toBeHidden();
  await touchGesture(page, person, 110);
  await expect(person).toHaveCount(0);
  await expect(info).toBeVisible();
});
