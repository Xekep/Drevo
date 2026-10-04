import { test, expect } from "@playwright/test";
import { familyViewAction } from "./tree-toolbar-actions";

test("new accounts see portrait cards with ancestors above descendants", async ({
  page,
}) => {
  await page.goto("/tree");
  const parent = page
    .locator('.flow-person[data-person-id="e2e-memorial-person"]')
    .first();
  const child = page
    .locator('.flow-person[data-person-id="e2e-child"]')
    .first();
  await expect(parent).toHaveClass(/is-portrait-card/);
  await expect(child).toHaveClass(/is-portrait-card/);
  const [parentBounds, childBounds] = await Promise.all([
    parent.boundingBox(),
    child.boundingBox(),
  ]);
  expect(parentBounds!.y).toBeLessThan(childBounds!.y);
});

test("each viewer can switch direction and colors; legacy card variants stay portrait", async ({
  page,
}, testInfo) => {
  let preferences = {
    reverseTimeline: false,
    cardVariant: "portrait",
    colorScheme: "warm",
  };
  let referenceId: string | undefined = "e2e-memorial-person";
  await page.addInitScript(() =>
    localStorage.setItem(
      "drevo:guest-tree-preferences:v1",
      JSON.stringify({
        reverseTimeline: true,
        cardVariant: "classic",
        colorScheme: "white",
      }),
    ),
  );
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
  await expect(self).toHaveClass(/is-portrait-card/);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/theme-white/);
  const initialOrder = await Promise.all([
    self.boundingBox(),
    child.boundingBox(),
  ]);
  expect(initialOrder[0]!.y).toBeLessThan(initialOrder[1]!.y);

  if (testInfo.project.name === "mobile") {
    await page.locator(".archive-more summary").click();
    await expect(page.locator(".archive-more .nav-bottom")).not.toContainText(
      "Моё древо",
    );
    await page.locator(".archive-more summary").click();
  } else {
    await expect(page.locator(".archive-more summary")).toBeVisible();
  }
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await expect(
    dialog.getByRole("combobox", { name: "Генеалогический формат" }),
  ).toHaveCount(0);
  await dialog.getByRole("radio", { name: "Белая" }).check();
  await expect(page.locator(".tree-canvas")).toHaveClass(/theme-white/);
  await expect(page.locator(".tree-canvas")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await dialog.getByRole("radio", { name: "Тёплая" }).check();
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/theme-white/);
  await dialog.getByRole("radio", { name: "Белая" }).check();
  await expect(self).toHaveClass(/is-portrait-card/);
  await expect
    .poll(() => self.evaluate((node) => node.clientHeight))
    .toBeGreaterThan(220);
  await expect
    .poll(() =>
      self.locator(".person-avatar").evaluate((node) => node.clientWidth),
    )
    .toBeGreaterThan(120);
  await expect(self).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect
    .poll(() =>
      self.evaluate((node) => {
        const wrapper = node.closest(".react-flow__node")!;
        return Math.abs(
          wrapper.getBoundingClientRect().height -
            node.getBoundingClientRect().height,
        );
      }),
    )
    .toBeLessThan(2);
  await expect(self.locator(".portrait-card-info small")).toHaveText("Это вы");
  await expect(child.locator(".portrait-card-info small")).toHaveText("Сын");
  await expect(self.locator(".portrait-card-years")).toHaveText("1940 — 2020");
  await expect(child.locator(".portrait-card-years")).toHaveText(
    "1965 — н. в.",
  );
  await dialog.getByRole("radio", { name: "Потомки сверху" }).check();
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
    colorScheme: "white",
  });
  const bounds = await dialog.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
    page.viewportSize()!.width,
  );
  await expect(dialog.getByText("Портрет", { exact: true })).toHaveCount(0);
  await expect(dialog.getByText("Классика", { exact: true })).toHaveCount(0);
  expect(bounds!.height).toBeLessThan(470);
  await dialog.screenshot({
    path: testInfo.outputPath("tree-settings-dialog.png"),
  });
  if (testInfo.project.name === "mobile") {
    await page.setViewportSize({ width: 320, height: 640 });
    const narrowBounds = await dialog.boundingBox();
    expect(narrowBounds!.x).toBeGreaterThanOrEqual(0);
    expect(narrowBounds!.x + narrowBounds!.width).toBeLessThanOrEqual(320);
    await dialog.getByRole("radio", { name: "Белая" }).scrollIntoViewIfNeeded();
  }

  await dialog.getByRole("button", { name: "Закрыть" }).click();
  const collapse = self.getByRole("button", { name: "Свернуть ветвь" });
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(child).toHaveCount(0);
  await expect(
    page.locator('.flow-person[data-person-id="e2e-spouse"]'),
  ).toHaveCount(0);
  await expect(self).toBeVisible();
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-layout-settling|is-growing/,
  );
  await self.getByRole("button", { name: "Развернуть ветвь" }).click();
  await expect(child).toBeVisible();
  await expect(
    page.locator('.flow-person[data-person-id="e2e-spouse"]').first(),
  ).toBeVisible();
  const household = page
    .locator(".flow-household:not(.flow-household--siblings)")
    .first();
  await expect(household).toBeVisible();
  expect(
    await household.evaluate((node) => {
      const band = Number.parseFloat(getComputedStyle(node, "::before").height);
      return band < node.clientHeight;
    }),
  ).toBe(true);
  await self.screenshot({ path: testInfo.outputPath("portrait-card.png") });
  await page.screenshot({ path: testInfo.outputPath("tree-preferences.png") });
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-layout-settling|is-growing/,
  );
  if (testInfo.project.name === "mobile") {
    const mode = page.getByRole("switch", { name: "Древо / Хронология" });
    await mode.click();
    await expect(mode).toBeChecked();
  } else {
    await page.getByRole("button", { name: "Хронология" }).click();
    await expect(
      page.getByRole("button", { name: "Хронология" }),
    ).toHaveAttribute("aria-pressed", "true");
  }
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
  await expect(page.locator(".tree-canvas")).toHaveClass(/theme-white/);
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
  ).toHaveCount(0);
  await expect(child).not.toContainText("Нет привязки к древу");
  await expect(child.getByRole("button").first()).not.toHaveAttribute(
    "aria-label",
    /Нет привязки к древу/,
  );
  await expect(self).toHaveClass(/is-compact/);
  await expect(
    self.getByRole("button", { name: "Свернуть ветвь" }),
  ).toBeVisible();
  await self.getByRole("button", { name: "Свернуть ветвь" }).click();
  await expect(
    self.getByRole("button", { name: "Развернуть ветвь" }),
  ).toBeVisible();
  await self.getByRole("button", { name: "Развернуть ветвь" }).click();
  await expect(
    self.getByRole("button", { name: "Свернуть ветвь" }),
  ).toBeVisible();
});

test("white scheme also colors the fan", async ({ page }, testInfo) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.treePreferences = {
      reverseTimeline: false,
      cardVariant: "classic",
      colorScheme: "white",
    };
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await expect(
    page.getByTestId("rf__node-e2e-child").locator(".flow-person"),
  ).toHaveClass(/is-selected/);
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Свернуть панель" }).click();
  await familyViewAction(page, "Веер");
  await expect(page.locator(".fan-chart")).toBeVisible();
  await expect(page.locator(".fan-chart")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
});
