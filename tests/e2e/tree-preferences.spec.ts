import { test, expect } from "@playwright/test";

test("each viewer can switch tree direction and a photo/name/kinship card", async ({
  page,
}, testInfo) => {
  let preferences = { reverseTimeline: false, cardVariant: "classic" };
  let referenceId: string | undefined = "e2e-memorial-person";
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = referenceId;
    data.treePreferences = preferences;
    data.reverseTimeline = preferences.reverseTimeline;
    await route.fulfill({ response, json: data });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    if (route.request().method() === "PUT") {
      preferences = route.request().postDataJSON();
    }
    await route.fulfill({ json: preferences });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/, {
    timeout: 5_000,
  });
  const self = page
    .locator('.flow-person[data-person-id="e2e-memorial-person"]')
    .first();
  const child = page
    .locator('.flow-person[data-person-id="e2e-child"]')
    .first();
  await expect(self).toBeVisible();
  await expect(child).toBeVisible();
  const initialOrder = await Promise.all([
    self.boundingBox(),
    child.boundingBox(),
  ]);
  expect(initialOrder[0]!.y).toBeLessThan(initialOrder[1]!.y);

  await page.locator(".archive-more > summary").click();
  await page.getByRole("button", { name: "Моё древо" }).click();
  const dialog = page.getByRole("dialog", { name: "Моё древо" });
  await dialog.getByRole("radio", { name: "Фото · ФИО · Родство" }).check();
  await expect(self).toHaveClass(/is-portrait-card/);
  await expect(self.locator(".portrait-card-info small")).toHaveText("Это вы");
  await expect(child.locator(".portrait-card-info small")).toHaveText("Сын");
  await dialog.getByRole("radio", { name: "Младшие сверху" }).check();
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([
        self.boundingBox(),
        child.boundingBox(),
      ]);
      return (a?.y || 0) > (b?.y || 0);
    })
    .toBe(true);
  expect(preferences).toEqual({
    reverseTimeline: true,
    cardVariant: "portrait",
  });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  const preview = await dialog
    .locator(".tree-card-preview.stacked-preview")
    .boundingBox();
  expect(preview!.width).toBeGreaterThan(150);
  expect(preview!.height).toBeGreaterThan(60);
  await dialog.screenshot({
    path: testInfo.outputPath("tree-settings-dialog.png"),
  });
  if (testInfo.project.name === "mobile") {
    const originalViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 320, height: 640 });
    const narrowBounds = await dialog.boundingBox();
    expect(narrowBounds!.x).toBeGreaterThanOrEqual(0);
    expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(320);
    await dialog
      .getByRole("radio", { name: "Фото · ФИО · Родство" })
      .scrollIntoViewIfNeeded();
    await page.setViewportSize(originalViewport);
  }

  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await self.screenshot({ path: testInfo.outputPath("portrait-card.png") });
  await page.screenshot({ path: testInfo.outputPath("tree-preferences.png") });
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-layout-settling|is-growing/,
  );
  await page.getByRole("button", { name: "Хронология" }).click();
  await expect(
    page.getByRole("button", { name: "Хронология" }),
  ).toHaveAttribute("aria-pressed", "true");
  const timeline = page.getByRole("region", {
    name: /Горизонтальная хронология/,
  });
  const year = Number(
    await page.locator(".timeline-center-marker output").textContent(),
  );
  await timeline.evaluate((element) => {
    element.scrollLeft += 120;
  });
  await expect
    .poll(async () =>
      Number(
        await page.locator(".timeline-center-marker output").textContent(),
      ),
    )
    .toBeGreaterThan(year);
  await page.reload();
  await expect(
    page.locator('.flow-person[data-person-id="e2e-child"]').first(),
  ).toHaveClass(/is-portrait-card/);
  referenceId = undefined;
  await page.reload();
  await expect(
    page
      .locator(
        '.flow-person[data-person-id="e2e-child"] .portrait-card-info small',
      )
      .first(),
  ).toHaveText("Нет привязки к древу");
});
