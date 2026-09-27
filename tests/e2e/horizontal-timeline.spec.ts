import { expect, test } from "@playwright/test";

test("хронология переключает десятилетия без перетаскивания шкалы", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Хронология", exact: true }).click();
  const year = page.getByLabel("Год в центре хронологии");
  await expect(year).toHaveText("1940");
  await page.getByRole("button", { name: "На 10 лет вперёд" }).click();
  await expect(year).toHaveText("1950");
  await page.getByRole("button", { name: "На 10 лет назад" }).click();
  await expect(year).toHaveText("1940");
});

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
  await expect(
    timeline.locator(".timeline-person-row:not(.is-exiting)"),
  ).toHaveCount(1);
  await expect(timeline.locator(".timeline-era-bar")).toBeVisible();
  await expect(timeline.locator(".timeline-band img")).not.toHaveCount(0);
  await expect(timeline.locator(".timeline-event.is-birth")).toHaveCount(1);
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
  await timeline.evaluate((element) => {
    const currentYear = Number(
      document.querySelector(".timeline-center-marker output")?.textContent,
    );
    element.scrollLeft += (1992 - currentYear) * 12;
  });
  await expect(marker).toHaveText("1992");
  await expect(
    timeline.locator(".timeline-person-row:not(.is-exiting)"),
  ).toHaveCount(6);
  await expect(timeline.locator(".timeline-event.is-birth")).toHaveCount(6);
  const birth = timeline.locator(
    '[data-person-id="e2e-grandchild"] .timeline-event.is-birth',
  );
  const birthMarker = await birth.locator("summary").boundingBox();
  if (!birthMarker) throw new Error("Birth marker has no bounds");
  const clickBirth = () =>
    page.mouse.click(
      birthMarker.x + birthMarker.width / 2,
      birthMarker.y + birthMarker.height / 2,
    );
  await clickBirth();
  await expect(birth.locator(".timeline-event-list")).toBeVisible();
  await expect(birth.locator(".timeline-event-list")).toContainText("Рождение");
  await expect(marker).toHaveText("1992");
  await clickBirth();
  await expect(marker).toHaveText("1992");
  await timeline.evaluate((element) => {
    element.scrollLeft += (2020 - 1992) * 12;
  });
  await expect(marker).toHaveText("2020");
  await expect(timeline.locator(".timeline-event.is-death")).toHaveCount(1);
  await timeline.evaluate((element) => {
    element.scrollLeft += 12;
  });
  await expect(marker).toHaveText("2021");
  await expect(
    timeline.locator(".timeline-person-row:not(.is-exiting)"),
  ).toHaveCount(5);
  const portrait = timeline
    .locator(".timeline-person-row:not(.is-exiting) .timeline-person")
    .first();
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

test("wheel moves through years, Shift+wheel moves people, and life bars track fractional scroll", async ({
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
  await timeline.evaluate((element) => {
    const year = Number(
      document.querySelector(".timeline-center-marker output")?.textContent,
    );
    element.scrollLeft += (1992 - year) * 12;
    element.style.bottom = "auto";
    element.style.height = "220px";
  });
  const bar = timeline.locator(
    '[data-person-id="e2e-grandchild"] .timeline-life',
  );
  await expect(bar).toBeVisible();
  await timeline.evaluate((element) => {
    const life = element.querySelector<HTMLElement>(
      '[data-person-id="e2e-grandchild"] .timeline-life',
    );
    element.scrollLeft = Number(life?.dataset.startX) + 1;
  });
  await expect
    .poll(() =>
      bar.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeLessThan(10);
  const widthBefore = await bar.evaluate(
    (element) => element.getBoundingClientRect().width,
  );
  const layoutWidth = await bar.evaluate((element) => element.style.width);
  await timeline.evaluate((element) => {
    element.scrollLeft += 3;
  });
  await expect
    .poll(() =>
      bar.evaluate((element) => element.getBoundingClientRect().width),
    )
    .toBeGreaterThan(widthBefore + 1);
  expect(await bar.evaluate((element) => element.style.width)).toBe(
    layoutWidth,
  );

  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error("Timeline has no bounds");
  await page.mouse.move(bounds.x + bounds.width * 0.7, bounds.y + 105);
  const before = await timeline.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  await page.mouse.wheel(0, 96);
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(before.left);
  expect(await timeline.evaluate((element) => element.scrollTop)).toBe(
    before.top,
  );
  const beforePeople = await timeline.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  await page.keyboard.down("Shift");
  await page.mouse.wheel(0, 96);
  await page.keyboard.up("Shift");
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(beforePeople.top);
  expect(await timeline.evaluate((element) => element.scrollLeft)).toBe(
    beforePeople.left,
  );
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
  await expect(
    timeline.locator(".timeline-person-row:not(.is-exiting)"),
  ).toHaveCount(1);
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
  await timeline.evaluate((element) => {
    const currentYear = Number(
      document.querySelector(".timeline-center-marker output")?.textContent,
    );
    element.scrollLeft += (1992 - currentYear) * 12;
  });
  await expect
    .poll(async () => Number(await marker.textContent()))
    .toBeGreaterThanOrEqual(1992);
  await expect(
    timeline.locator(".timeline-person-row:not(.is-exiting)"),
  ).toHaveCount(6);
  await timeline.screenshot({
    path: testInfo.outputPath("timeline-mobile.png"),
  });
  await page.setViewportSize({ width: 320, height: 640 });
  const counter = await page
    .locator(".timeline-center-marker > span")
    .boundingBox();
  if (!counter) throw new Error("Year counter has no bounds");
  expect(counter.x).toBeGreaterThanOrEqual(0);
  expect(counter.x + counter.width).toBeLessThanOrEqual(320);
  await expect(
    timeline.locator(".timeline-person-row:not(.is-exiting)"),
  ).toHaveCount(6);
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
  await timeline.evaluate((element) => {
    const currentYear = Number(
      document.querySelector(".timeline-center-marker output")?.textContent,
    );
    element.scrollLeft += (1992 - currentYear) * 12;
    element.style.bottom = "auto";
    element.style.height = "220px";
  });
  await expect(
    timeline.locator(".timeline-person-row:not(.is-exiting)"),
  ).toHaveCount(6);
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
    element.scrollTop = Math.min(
      150,
      element.scrollHeight - element.clientHeight,
    );
    return element.scrollTop;
  });
  expect(scrollTop).toBeGreaterThan(40);
  await expect
    .poll(async () => Math.abs((await centerY()) - before))
    .toBeLessThan(3);
});
