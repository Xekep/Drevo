import { expect, test, type Locator } from "@playwright/test";
import { pagedPhotoFixture } from "./paged-photo-fixture";

async function setRange(input: Locator, value: number) {
  await input.evaluate((element, next) => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(element, String(next));
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
}

test("portrait starts on the selected mark and saves the same rotated pixels on desktop and mobile", async ({
  page,
  isMobile,
}, info) => {
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1200;
    canvas.height = 800;
    const ctx = canvas.getContext("2d")!;
    ctx.fillStyle = "#263238";
    ctx.fillRect(0, 0, 1200, 800);
    for (const [color, x, y] of [
      ["#ff0000", 800, 240],
      ["#00ff00", 840, 240],
      ["#0000ff", 800, 280],
      ["#ffff00", 840, 280],
    ] as const) {
      ctx.fillStyle = color;
      ctx.fillRect(x, y, 40, 40);
    }
    return canvas.toDataURL("image/png");
  });
  const source = {
    id: "crop-source",
    url: "/media/crop-source.png",
    title: "Тест кадрирования",
    tags: [
      {
        id: "other",
        personId: "e2e-memorial-person",
        x: 0.1,
        y: 0.1,
        width: 0.1,
        height: 0.1,
      },
      {
        id: "selected",
        personId: "e2e-child",
        x: 800 / 1200,
        y: 240 / 800,
        width: 80 / 1200,
        height: 80 / 800,
      },
    ],
  };
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.totals.photos = 1;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/family?projection=details&**", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    if (response.ok()) {
      data.photos = [source];
      data.photoTotal = 1;
      data.personPhotoTotals = Object.fromEntries(
        Object.keys(data.personPhotoTotals || {}).map((id) => [
          id,
          source.tags.some((tag) => tag.personId === id) ? 1 : 0,
        ]),
      );
    }
    await route.fulfill({ status: response.status(), json: data });
  });
  await page.route(
    "**/api/family?projection=page&collection=photos&**",
    (route) =>
      route.fulfill({
        json: {
          pageToken: new URL(route.request().url()).searchParams.get("token"),
          total: 1,
          items: [source],
        },
      }),
  );
  await page.route("**/media/crop-source.png**", (route) =>
    route.fulfill({
      contentType: "image/png",
      body: Buffer.from(dataUrl.split(",")[1], "base64"),
    }),
  );
  await pagedPhotoFixture(page, [source]);
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-growing|is-growth-preparing|is-layout-settling/,
  );
  const card = page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content");
  if (isMobile) await card.tap();
  else await card.click();
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.locator(".person-editor-form .portrait-preview").click();
  await page.locator(".portrait-gallery button").first().click();
  const cropper = page.locator(".portrait-cropper"),
    area = cropper.locator(".portrait-crop-area");
  const zoom = cropper.getByRole("slider", { name: "Масштаб", exact: true });
  const rotation = cropper.getByRole("slider", { name: /Поворот/ });
  await expect(area).toBeEnabled();
  const initialZoom = 800 / Math.hypot(80, 80);
  expect(Number(await zoom.inputValue())).toBeCloseTo(initialZoom, 6);
  const framing = await area.evaluate((element) => {
    const img = element.querySelector("img")!,
      box = element.getBoundingClientRect(),
      imageBox = img.getBoundingClientRect();
    return {
      x: imageBox.x + (imageBox.width * 840) / 1200 - box.x - box.width / 2,
      y: imageBox.y + (imageBox.height * 280) / 800 - box.y - box.height / 2,
      diameter: (element.clientWidth * 1200) / imageBox.width,
    };
  });
  expect(Math.abs(framing.x)).toBeLessThan(2);
  expect(Math.abs(framing.y)).toBeLessThan(2);
  expect(framing.diameter).toBeCloseTo(Math.hypot(80, 80), 0);
  await setRange(rotation, 90);
  await expect(cropper.locator("output")).toHaveText("90°");
  await area.focus();
  await page.keyboard.press("ArrowRight");
  const moved = await area.locator("img").getAttribute("style");
  await cropper.getByRole("button", { name: "Сбросить", exact: true }).click();
  await expect(rotation).toHaveValue("0");
  await expect(area.locator("img")).not.toHaveAttribute("style", moved!);
  expect(Number(await zoom.inputValue())).toBeCloseTo(initialZoom, 6);
  await setRange(rotation, 90);
  // Pointer movement remains usable after rotation, including touch capture.
  const before = await area.locator("img").getAttribute("style"),
    box = (await area.boundingBox())!;
  if (isMobile) {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x: box.x + box.width / 2, y: box.y + box.height / 2 }],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { x: box.x + box.width / 2 + 30, y: box.y + box.height / 2 + 15 },
      ],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
  } else {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      box.x + box.width / 2 + 30,
      box.y + box.height / 2 + 15,
      { steps: 5 },
    );
    await page.mouse.up();
  }
  await expect(area.locator("img")).not.toHaveAttribute("style", before!);
  await cropper.getByRole("button", { name: "Сбросить", exact: true }).click();
  await setRange(rotation, 90);
  await page.screenshot({ path: info.outputPath("portrait-crop.png") });
  const saveBox = (await cropper.getByRole("button", { name: "Использовать портрет", exact: true }).boundingBox())!;
  expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  const width = await page.evaluate(() => ({
    viewport: innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(width.content).toBeLessThanOrEqual(width.viewport);
  await cropper
    .getByRole("button", { name: "Использовать портрет", exact: true })
    .click();
  const preview = page.locator(".person-editor-form .portrait-preview img");
  await expect(preview).toHaveAttribute("src", /^blob:/);
  const saved = await preview.evaluate(async (element) => {
    const image = element as HTMLImageElement;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 640;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(image, 0, 0);
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      colors: [
        [240, 240],
        [400, 240],
        [240, 400],
        [400, 400],
      ].map(([x, y]) => [...ctx.getImageData(x, y, 1, 1).data]),
    };
  });
  expect(saved).toEqual({
    width: 640,
    height: 640,
    colors: [
      [0, 0, 255, 255],
      [255, 0, 0, 255],
      [255, 255, 0, 255],
      [0, 255, 0, 255],
    ],
  });
});
