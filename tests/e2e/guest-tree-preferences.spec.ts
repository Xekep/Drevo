import { expect, test } from "@playwright/test";

for (const mode of ["shared", "public"] as const)
  test(`guest can configure ${mode} tree without changing account or share settings`, async ({
    page,
    isMobile,
  }, testInfo) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const before = await (
      await page.request.get("/api/tree-preferences")
    ).json();
    const archive = await (await page.request.get("/api/family")).json();
    const token = "s".repeat(43);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().includes("/api/") &&
        !["GET", "HEAD"].includes(request.method())
      )
        writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
    });
    if (mode === "shared") {
      await page.route(`**/api/shared/${token}`, (route) =>
        route.fulfill({
          json: {
            family: archive.family,
            reverseTimeline: true,
            serverTime: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      );
    } else {
      await page.route("**/api/family?projection=overview", (route) =>
        route.fulfill({
          json: {
            ...archive,
            user: null,
            canEdit: false,
            readTree: true,
            partial: false,
            treePreferences: null,
            reverseTimeline: true,
          },
        }),
      );
    }
    await page.goto(mode === "shared" ? `/s/${token}` : "/tree");
    const canvas = page.locator(".tree-canvas");
    await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
    await expect(page.locator(".flow-person").first()).toBeVisible();
    await expect
      .poll(() => page.locator(".react-flow__edge").count())
      .toBeGreaterThan(0);
    await expect(page.locator(".portrait-card-info small")).toHaveCount(0);
    const gear = page.getByRole("button", { name: "Настройки древа" });
    await expect(gear).toBeVisible();
    const gearBox = (await gear.boundingBox())!;
    expect(gearBox.x + gearBox.width).toBeGreaterThan(
      page.viewportSize()!.width - 40,
    );
    await gear.click();
    const dialog = page.getByRole("dialog", { name: "Вид древа" });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole("combobox", { name: "Генеалогический формат" }),
    ).toHaveCount(0);
    await expect(dialog.getByText(/Личные настройки/)).toHaveCount(0);
    await expect(
      dialog.getByRole("radio", { name: "Предки сверху" }),
    ).toBeChecked();
    await dialog.getByRole("radio", { name: "Потомки сверху" }).check();
    await dialog.getByRole("radio", { name: "Предки сверху" }).check();
    await expect(dialog.getByRole("radio", { name: "Фото · ФИО" })).toHaveCount(
      0,
    );
    await dialog.getByRole("radio", { name: "Белая" }).check();
    await expect(canvas).toHaveClass(/theme-white/);
    await expect(canvas).toHaveClass(/has-portrait-cards/);
    if (isMobile) await page.setViewportSize({ width: 320, height: 640 });
    const bounds = (await dialog.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(
      page.viewportSize()!.width,
    );
    expect(bounds.height).toBeLessThan(600);
    expect(
      await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBe(true);
    await dialog.screenshot({
      path: testInfo.outputPath(`${mode}-tree-settings.png`),
    });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(gear).toBeFocused();
    await page.screenshot({
      path: testInfo.outputPath(`${mode}-tree-toolbar.png`),
    });
    await page.reload();
    await expect(canvas).toHaveClass(/theme-white/);
    await expect(canvas).toHaveClass(/has-portrait-cards/);
    await expect(page.locator(".flow-person").first()).toBeVisible();
    await expect
      .poll(() => page.locator(".react-flow__edge").count())
      .toBeGreaterThan(0);
    await gear.click();
    await expect(
      dialog.getByRole("radio", { name: "Предки сверху" }),
    ).toBeChecked();
    await expect(dialog.getByRole("radio", { name: "Фото · ФИО" })).toHaveCount(
      0,
    );
    await dialog.getByRole("button", { name: "Закрыть" }).click();
    expect(writes).toEqual([]);
    expect(
      await (await page.request.get("/api/tree-preferences")).json(),
    ).toEqual(before);
  });
