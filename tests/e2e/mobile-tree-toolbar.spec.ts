import { expect, test, type Page } from "@playwright/test";

async function expectSingleRow(page: Page, width: number) {
  const bar = page.locator(".tree-mode-bar");
  const controls = bar.locator("button:visible, summary:visible");
  const bounds = await controls.evaluateAll((elements) =>
    elements.map((element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    }),
  );
  expect(bounds.length).toBeGreaterThanOrEqual(3);
  for (const [index, box] of bounds.entries()) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(Math.abs(box.y - bounds[0].y)).toBeLessThan(2);
    if (index)
      expect(box.x).toBeGreaterThanOrEqual(
        bounds[index - 1].x + bounds[index - 1].width,
      );
  }
  expect(
    await bar.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);
}

test("мобильная панель помещается в один ряд и сохраняет переключение и действия с семьёй", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  const mode = page.getByRole("switch", { name: "Древо / Хронология" });
  for (const width of [320, 360, 390, 430]) {
    await page.setViewportSize({ width, height: 844 });
    await expectSingleRow(page, width);
    await mode.click();
    await expect(mode).toBeChecked();
    await expect(
      page.getByRole("region", { name: /Горизонтальная хронология/ }),
    ).toBeVisible();
    await expectSingleRow(page, width);
    await mode.click();
    await expect(mode).not.toBeChecked();
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await page
    .getByRole("button", {
      name: "Тестов Пётр Иванович, 1965 — н. в.",
      exact: true,
    })
    .click();
  await page.getByRole("button", { name: "Свернуть панель" }).click();
  await expectSingleRow(page, 320);
  const menu = page.getByLabel("Область просмотра", { exact: true });
  await menu.click();
  await expect(
    page.getByRole("button", { name: "Общие предки" }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
  await expect(
    page.getByRole("button", { name: "Общие предки" }),
  ).not.toBeVisible();
  await menu.press("Enter");
  await page.getByRole("button", { name: "Общие предки" }).click();
  await expect(page.getByTestId("rf__node-e2e-spouse")).toHaveCount(0);
  await expectSingleRow(page, 320);
  await menu.click();
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(page.locator(".tree-family-count")).toHaveCount(0);
  await menu.click();
  await page.getByRole("button", { name: "Веер", exact: true }).click();
  await expect(page.locator(".fan-chart-svg")).toBeVisible();
  await expectSingleRow(page, 320);
  await mode.click();
  await expect(page.locator(".fan-chart-svg")).toHaveCount(0);
  await expect(mode).toBeChecked();
  await expectSingleRow(page, 320);
  const extra = page.getByRole("button", { name: "Доп. связи" });
  const pressed = await extra.getAttribute("aria-pressed");
  await extra.click();
  await expect(extra).toHaveAttribute(
    "aria-pressed",
    pressed === "true" ? "false" : "true",
  );
  await page.screenshot({ path: testInfo.outputPath("toolbar-320.png") });
  await page.getByRole("button", { name: "Родство", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Как мы связаны" }),
  ).toBeVisible();
  const archive = await (await page.request.get("/api/family")).json();
  const shared = await page.request.post("/api/shares", {
    headers: {
      Origin: "http://127.0.0.1:4173",
      "If-Match": String(archive.revision),
    },
    data: {
      title: "Проверка мобильной панели",
      anchorId: "e2e-memorial-person",
      personIds: ["e2e-memorial-person", "e2e-sibling-child"],
      durationHours: 1,
    },
  });
  expect(shared.status()).toBe(201);
  await page.goto((await shared.json()).path);
  await expect(mode).toBeVisible();
  await expectSingleRow(page, 320);
  await mode.click();
  await expect(mode).toBeChecked();
  await expectSingleRow(page, 320);
  await page.getByRole("button", { name: "Родство", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Как мы связаны" }),
  ).toBeVisible();
});
