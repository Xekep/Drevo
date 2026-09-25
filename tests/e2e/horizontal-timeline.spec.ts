import { expect, test } from "@playwright/test";

test("chronology has a horizontal era strip, sticky portraits and draggable dates", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/, {
    timeout: 5_000,
  });
  await page.getByRole("button", { name: "Хронология" }).click();
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  await expect(timeline).toBeVisible();
  await expect(timeline.locator(".timeline-person-row")).toHaveCount(6);
  await expect(timeline.locator(".timeline-era-bar")).toBeVisible();
  await expect(timeline.locator(".timeline-band img")).not.toHaveCount(0);
  await expect(timeline.locator(".timeline-event.is-birth")).toHaveCount(6);
  const marker = page.locator(".timeline-center-marker output");
  await expect(marker).toBeVisible();
  const yearBefore = Number(await marker.textContent());

  const before = await timeline.evaluate((element) => element.scrollLeft);
  const area = await timeline.boundingBox();
  const track = await timeline
    .locator(".timeline-row-track")
    .first()
    .boundingBox();
  if (!area) throw new Error("Timeline has no bounds");
  if (!track) throw new Error("Timeline row has no bounds");
  await page.mouse.move(area.x + area.width * 0.7, track.y + 15);
  await page.mouse.down();
  await page.mouse.move(area.x + area.width * 0.7 - 200, track.y + 15, {
    steps: 12,
  });
  await page.mouse.up();
  const after = await timeline.evaluate((element) => element.scrollLeft);
  expect(after).toBeGreaterThan(before);
  await expect
    .poll(async () => Number(await marker.textContent()))
    .toBeGreaterThan(yearBefore);
  const portrait = timeline.locator(".timeline-person").first();
  const portraitBox = await portrait.boundingBox();
  expect(portraitBox?.x).toBeGreaterThanOrEqual(area.x - 1);
  expect(portraitBox?.x).toBeLessThan(area.x + 3);

  await timeline.screenshot({
    path: testInfo.outputPath("timeline-desktop.png"),
  });
  await page
    .locator(".tree-mode-bar")
    .getByRole("button", { name: "Древо", exact: true })
    .click();
  await expect(timeline).toHaveCount(0);
  await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
});

test("chronology keeps portraits and epochs usable on a phone", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/, {
    timeout: 5_000,
  });
  await page.getByRole("button", { name: "Хронология" }).click();
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  await expect(timeline).toBeVisible();
  await expect(timeline.locator(".timeline-person-row")).toHaveCount(6);
  const marker = page.locator(".timeline-center-marker output");
  await expect(marker).toBeVisible();
  const yearBefore = Number(await marker.textContent());
  const bounds = await timeline.boundingBox();
  const portrait = await timeline
    .locator(".timeline-person")
    .first()
    .boundingBox();
  expect(bounds).not.toBeNull();
  expect(portrait).not.toBeNull();
  expect(portrait!.width).toBeLessThan(160);
  expect(portrait!.x).toBeGreaterThanOrEqual(bounds!.x - 1);
  const before = await timeline.evaluate((element) => element.scrollLeft);
  const session = await page.context().newCDPSession(page);
  const y = bounds!.y + 88;
  const startX = bounds!.x + bounds!.width - 20;
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: startX, y }],
  });
  for (let step = 1; step <= 8; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: startX - step * 15, y }],
    });
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(before);
  await expect
    .poll(async () => Number(await marker.textContent()))
    .toBeGreaterThan(yearBefore);
  await timeline.screenshot({
    path: testInfo.outputPath("timeline-mobile.png"),
  });
});

test("era emblems stay vertically centered while chronology scrolls", async ({
  page,
}) => {
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/, {
    timeout: 5_000,
  });
  await page.getByRole("button", { name: "Хронология" }).click();
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  const emblem = timeline.locator(".timeline-band.soviet img");
  await expect(emblem).toBeVisible();
  const centerY = async () => {
    const bounds = await emblem.boundingBox();
    if (!bounds) throw new Error("Era emblem has no bounds");
    return bounds.y + bounds.height / 2;
  };
  const viewport = await timeline.boundingBox();
  if (!viewport) throw new Error("Timeline has no bounds");
  const before = await centerY();
  expect(Math.abs(before - (viewport.y + viewport.height / 2))).toBeLessThan(8);
  const scrollTop = await timeline.evaluate((element) => {
    element.scrollTop = Math.min(150, element.scrollHeight - element.clientHeight);
    return element.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(40);
  await expect
    .poll(async () => Math.abs((await centerY()) - before))
    .toBeLessThan(3);
});
