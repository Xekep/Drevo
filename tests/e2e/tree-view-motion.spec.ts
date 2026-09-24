import { expect, test } from "@playwright/test";

test("family, common ancestors and branch changes animate their cards and camera", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  const child = page.getByTestId("rf__node-e2e-child");
  await child.locator(".flow-person-content").click();
  const viewport = page.locator(".react-flow__viewport");

  await page.getByRole("button", { name: "Семья выбранного" }).click();
  await expect(canvas).toHaveClass(/is-layout-settling/);
  await expect(canvas.locator(".tree-exit-node")).not.toHaveCount(0);
  await expect(canvas.locator(".tree-exit-node").first()).toHaveCSS(
    "animation-name",
    "tree-layout-exit",
  );
  const familyStart = await viewport.getAttribute("style");
  await page.waitForTimeout(150);
  const familyMiddle = await viewport.getAttribute("style");
  await page.waitForTimeout(550);
  const familyEnd = await viewport.getAttribute("style");
  expect(familyMiddle).not.toBe(familyStart);
  expect(familyMiddle).not.toBe(familyEnd);

  await page.getByRole("button", { name: "Общие предки" }).click();
  await expect(canvas).toHaveClass(/is-layout-settling/);
  await expect(
    canvas.locator(".tree-exit-node, .tree-enter-node"),
  ).not.toHaveCount(0);
  const commonStart = await viewport.getAttribute("style");
  await page.waitForTimeout(150);
  const commonMiddle = await viewport.getAttribute("style");
  await page.waitForTimeout(550);
  const commonEnd = await viewport.getAttribute("style");
  expect(commonMiddle).not.toBe(commonStart);
  expect(commonMiddle).not.toBe(commonEnd);

  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(canvas).not.toHaveClass(/is-layout-settling/, {
    timeout: 2_000,
  });
  const collapse = child.getByRole("button", { name: "Свернуть потомков" });
  await collapse.click();
  await expect(canvas).toHaveClass(/is-layout-settling/);
  await expect(canvas.locator(".tree-exit-node")).not.toHaveCount(0);
});

test("AI launcher moves to the edge when the fan hides camera controls", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Веер", exact: true }).click();
  await expect(canvas).toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  const trigger = page.getByRole("button", {
    name: "Открыть ИИ-исследователя",
  });
  await expect
    .poll(async () => {
      const tree = await canvas.boundingBox();
      const button = await trigger.boundingBox();
      return tree && button
        ? tree.x + tree.width - (button.x + button.width)
        : Infinity;
    })
    .toBeLessThan(35);
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(canvas).not.toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  const tools = canvas.locator(".flow-camera-tools");
  await expect(tools).toBeVisible();
  await expect
    .poll(async () => {
      const tool = await tools.boundingBox();
      const button = await trigger.boundingBox();
      return tool && button
        ? Math.abs(button.x + button.width + 8 - tool.x)
        : Infinity;
    })
    .toBeLessThan(12);
});

test("AI focuses one person without zooming out", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({ answer: "Показываю человека в древе.", references: [], suggestionIds: [], uiActions: [{ type: "focus_people", personIds: ["e2e-grandchild"] }] })}\n\n`,
    }),
  );
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/, {
    timeout: 5_000,
  });
  const viewport = page.locator(".react-flow__viewport");
  await page
    .locator(".flow-camera-tools")
    .getByRole("button", { name: "Увеличить" })
    .click();
  await page.waitForTimeout(400);
  const before = await viewport.evaluate((element) =>
    Number(element.getAttribute("style")?.match(/scale\(([^)]+)\)/)?.[1] || 0),
  );
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await panel.getByRole("textbox").fill("Покажи человека в древе");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  const card = page.getByTestId("rf__node-e2e-grandchild");
  await expect(card).toHaveClass(/selected/);
  await expect
    .poll(async () => {
      const [cardBox, canvasBox] = await Promise.all([
        card.boundingBox(),
        page.locator(".tree-canvas").boundingBox(),
      ]);
      return cardBox && canvasBox
        ? Math.abs(
            cardBox.x + cardBox.width / 2 - (canvasBox.x + canvasBox.width / 2),
          )
        : Infinity;
    })
    .toBeLessThan(20);
  const after = await viewport.evaluate((element) =>
    Number(element.getAttribute("style")?.match(/scale\(([^)]+)\)/)?.[1] || 0),
  );
  expect(after).toBeGreaterThanOrEqual(before - 0.01);
  await expect(panel).toBeVisible();
});
