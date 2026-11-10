import { expect, test } from "@playwright/test";

test("horizontal wheel glides and the existing era labels remain readable", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto("/tree");
  await page.getByRole("button", { name: "Хронология", exact: true }).click();
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  await expect(timeline).toBeVisible();
  const epochs = page.locator(".timeline-era-segment");
  const names = await epochs.locator(":scope > span").allTextContents();
  expect(names.length).toBeGreaterThan(1);
  await expect(page.locator(".timeline-era-bar")).toBeVisible();

  await timeline.evaluate((element) => {
    const year = Number(document.querySelector(".timeline-center-marker output")?.textContent);
    element.scrollLeft += (1940 - year) * 12;
  });
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1940");
  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error("Timeline has no bounds");
  await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + 110);
  const before = await timeline.evaluate((element) => element.scrollLeft);
  await page.mouse.wheel(0, 160);
  // The prototype's smooth mode applies a 1.25x wheel multiplier.
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(before + 190);
  expect(await epochs.locator(":scope > span").allTextContents()).toEqual(names);
});

test("dragging the timeline pans the dates and releases with momentum", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto("/tree");
  await page.getByRole("button", { name: "Хронология", exact: true }).click();
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  await timeline.evaluate((element) => {
    const year = Number(document.querySelector(".timeline-center-marker output")?.textContent);
    element.scrollLeft += (1940 - year) * 12;
  });
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1940");
  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error("Timeline has no bounds");
  const x = bounds.x + bounds.width * 0.8;
  const y = bounds.y + 120;
  const before = await timeline.evaluate((element) => element.scrollLeft);
  // Record the native scroll offset before React handles pointer release.
  await page.evaluate(() => {
    window.addEventListener(
      "pointerup",
      () => {
        const timeline = document.querySelector(".horizontal-timeline");
        if (timeline instanceof HTMLElement)
          timeline.dataset.releaseLeft = String(timeline.scrollLeft);
      },
      { capture: true, once: true },
    );
  });
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 120, y, { steps: 8 });
  await expect(timeline).toHaveClass(/is-dragging/);
  await page.mouse.up();
  const released = Number(await timeline.getAttribute("data-release-left"));
  expect(released).toBeGreaterThan(before + 100);
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(released + 15);
  await expect(page.locator(".timeline-era-segment.soviet")).toContainText("СССР");
});

test("grabbing wheel inertia stops at the current position without rewinding", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto("/tree");
  await page.getByRole("button", { name: "Хронология", exact: true }).click();
  const timeline = page.getByRole("region", { name: /Горизонтальная хронология/ });
  await timeline.evaluate((element) => {
    const year = Number(document.querySelector(".timeline-center-marker output")?.textContent);
    element.scrollLeft += (1940 - year) * 12;
  });
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1940");
  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error("Timeline has no bounds");
  const x = bounds.x + bounds.width * 0.8, y = bounds.y + 120;
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, 400);
  await page.waitForTimeout(50);
  await page.mouse.down();
  const pressed = await timeline.evaluate((element) => element.scrollLeft);
  await page.waitForTimeout(220);
  expect(await timeline.evaluate((element) => element.scrollLeft)).toBeCloseTo(pressed, 0);
  await page.mouse.move(x - 8, y);
  expect(await timeline.evaluate((element) => element.scrollLeft)).toBeCloseTo(pressed + 8, 0);
  await page.mouse.up();
});

test("reduced motion keeps mouse dragging immediate and disables the throw", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Хронология", exact: true }).click();
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  await timeline.evaluate((element) => {
    const year = Number(document.querySelector(".timeline-center-marker output")?.textContent);
    element.scrollLeft += (1940 - year) * 12;
  });
  await expect(page.getByLabel("Год в центре хронологии")).toHaveText("1940");
  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error("Timeline has no bounds");
  const x = bounds.x + bounds.width * 0.75;
  const y = bounds.y + 120;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x - 100, y, { steps: 6 });
  await page.mouse.up();
  const released = await timeline.evaluate((element) => element.scrollLeft);
  await page.waitForTimeout(180);
  expect(await timeline.evaluate((element) => element.scrollLeft)).toBeCloseTo(
    released,
    0,
  );
});
