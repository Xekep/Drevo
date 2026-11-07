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
  const epochs = timeline.locator(".timeline-era-segment");
  const names = await epochs.allTextContents();
  expect(names.length).toBeGreaterThan(1);
  await expect(timeline.locator(".timeline-era-bar")).toBeVisible();

  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error("Timeline has no bounds");
  await page.mouse.move(bounds.x + bounds.width * 0.8, bounds.y + 110);
  const before = await timeline.evaluate((element) => element.scrollLeft);
  await page.mouse.wheel(0, 160);
  // The prototype's smooth mode applies a 1.25x wheel multiplier.
  await expect
    .poll(() => timeline.evaluate((element) => element.scrollLeft))
    .toBeGreaterThan(before + 190);
  expect(await epochs.allTextContents()).toEqual(names);
});

test("dragging the named era strip pans the timeline and releases with momentum", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto("/tree");
  await page.getByRole("button", { name: "Хронология", exact: true }).click();
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  const era = timeline.locator(".timeline-era-segment.soviet");
  await expect(era).toBeVisible();
  const box = await era.boundingBox();
  if (!box) throw new Error("Soviet era is not laid out");
  const bounds = await timeline.boundingBox();
  if (!bounds) throw new Error("Timeline has no bounds");
  const x = Math.min(
    bounds.x + bounds.width - 30,
    Math.max(bounds.x + 230, box.x + box.width / 2),
  );
  const y = box.y + box.height / 2;
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
  await expect(era).toContainText("СССР");
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
