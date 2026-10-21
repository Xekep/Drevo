import { expect, test, type Locator, type Page } from "@playwright/test";

async function graphView(plot: Locator) {
  return plot.evaluate(async (element) => {
    const url = performance.getEntriesByType("resource")
      .find((entry) => /\/echarts-runtime-[^/]+\.js(?:\?|$)/.test(entry.name))!.name;
    const { echarts } = await import(url);
    const series = echarts.getInstanceByDom(element).getOption().series[0];
    return { zoom: series.zoom, center: series.center };
  });
}

async function navigateGraph(page: Page, plot: Locator) {
  await plot.scrollIntoViewIfNeeded();
  const box = (await plot.boundingBox())!;
  const messages = await page.locator(".research-assistant-messages").boundingBox();
  const x = box.x + 12;
  const fullscreen = await page.locator(".research-visual-overlay").count();
  const y = Math.max(box.y + 12, messages && !fullscreen ? messages.y + 12 : 0);
  const before = await graphView(plot);
  const pageBefore = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  const chatBefore = await page.locator(".research-assistant-messages").evaluate((element) => element.scrollTop);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 40, y + 32, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => (await graphView(plot)).center).not.toEqual(before.center);
  const moved = await graphView(plot);
  await page.mouse.move(x, y);
  await page.mouse.wheel(0, -100);
  await expect.poll(async () => (await graphView(plot)).zoom).toBeGreaterThan(moved.zoom);
  const zoomed = await graphView(plot);
  await page.mouse.wheel(0, 100);
  await expect.poll(async () => (await graphView(plot)).zoom).toBeLessThan(zoomed.zoom);
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(pageBefore);
  expect(await page.locator(".research-assistant-messages").evaluate((element) => element.scrollTop)).toBe(chatBefore);
}

test("экранированная ссылка ИИ на фото становится кнопкой", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({
        answer: String.raw`На \[Фотография · 11 человек\](#drevo-photo-d6688201-4f30-47a2-a99b-39d0bb5ec2cf) изображено **11 человек**.`,
        references: [],
        suggestionIds: [],
        uiActions: [],
        files: [],
      })}\n\n`,
    }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await page.locator(".research-assistant textarea").fill("Покажи фото");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(
    page
      .locator(".research-assistant article.is-assistant")
      .getByRole("button", {
        name: "Фотография · 11 человек",
      }),
  ).toBeVisible();
});

test("ИИ показывает готовый ответ и раскрывает Mermaid-граф с масштабом", async ({
  page,
}) => {
  await page.setViewportSize({ width: 750, height: 500 });
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: [
        'event: status\ndata: {"message":"Проверяю сведения в архиве…"}\n\n',
        "event: done\ndata: " +
          JSON.stringify({
            answer:
              'Схема:\n\n```mermaid\ngraph TD\n  a["Анна<br/>1900–1980"] -->|родитель → ребёнок| c[Ребёнок]\n  b[Иван] -->|родитель → ребёнок| c\n  a ---|супруги| b\n  c -->|родитель → ребёнок| d[Внук]\n```',
            references: [],
            suggestionIds: [],
            uiActions: [],
            files: [],
          }) +
          "\n\n",
      ].join(""),
    }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await page.locator(".research-assistant textarea").fill("Покажи схему");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".research-visual canvas")).toBeVisible();
  await navigateGraph(page, page.locator(".research-visual-plot"));
  await expect(
    page.locator(".research-assistant article.is-assistant"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Развернуть схему" }).click();
  const dialog = page.getByRole("dialog", { name: "Схема родства" });
  await expect(
    dialog.locator(".research-visual-dialog-plot canvas"),
  ).toBeVisible();
  const close = dialog.getByRole("button", { name: "Закрыть схему" });
  await expect(close).toBeFocused();
  await navigateGraph(page, dialog.locator(".research-visual-dialog-plot"));
  await page.keyboard.press("Tab");
  await expect(
    dialog.getByRole("button", { name: "Уменьшить схему" }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(close).toBeFocused();
  // Even a script cannot focus the input behind a native modal dialog.
  await page.locator(".research-assistant textarea")
    .evaluate((input) => (input as HTMLElement).focus());
  await expect(close).toBeFocused();
  await expect(dialog.getByRole("img")).toHaveAttribute(
    "aria-label",
    /1900–1980.*родитель → ребёнок/,
  );
  const wheelCanvas = dialog.locator(".research-visual-dialog-plot");
  const wheelBox = await wheelCanvas.boundingBox();
  expect(wheelBox).not.toBeNull();
  await page.mouse.move(
    wheelBox!.x + wheelBox!.width / 2,
    wheelBox!.y + wheelBox!.height / 2,
  );
  await page.mouse.wheel(0, -100);
  await dialog.getByRole("button", { name: "Увеличить схему" }).click();
  await dialog.getByRole("button", { name: "Уменьшить схему" }).click();
  await expect(
    dialog.locator(".research-visual-dialog-plot canvas"),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть схему" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Развернуть схему" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Развернуть схему" }),
  ).toBeFocused();
});

test("ИИ показывает круговую и временную диаграммы на Canvas", async ({
  page,
}) => {
  const answers = [
    '```mermaid\npie title Родственные ветви\n"Первая": 3\n"Вторая": 2\n```',
    '```mermaid\nxychart-beta\n  title "Люди по годам"\n  x-axis ["1900", "1950", "2000"]\n  bar [1, 4, 8]\n```',
    '```xychart\n title "Продолжительность жизни"\n x-axis [1-е поколение, 2-е поколение, 3-е поколение]\n bar [67, 68, 47]\n```',
  ];
  let call = 0;
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({
        answer: answers[call++],
        references: [],
        suggestionIds: [],
        uiActions: [],
        files: [],
      })}\n\n`,
    }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const input = page.locator(".research-assistant textarea");
  await input.fill("Покажи доли");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".research-visual canvas")).toHaveCount(1);
  await input.fill("Покажи годы");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".research-visual canvas")).toHaveCount(2);
  await input.fill("Покажи продолжительность жизни");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".research-visual canvas")).toHaveCount(3);
  await expect(page.locator(".research-visual").last().getByRole("img")).toHaveAttribute("aria-label", /1-е поколение.*2-е поколение.*3-е поколение/);
  await expect(page.locator("code.language-xychart")).toHaveCount(0);
  await expect(page.locator(".research-visual svg")).toHaveCount(0);
});

test("короткая команда приближает само древо", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({
        answer: "Приблизил древо.",
        references: [],
        suggestionIds: [],
        uiActions: [{ type: "zoom_in" }],
        files: [],
      })}\n\n`,
    }),
  );
  await page.goto("/tree");
  const zoomLabel = page.locator(".flow-camera-tools span");
  await expect(zoomLabel).toBeVisible();
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/);
  await page.waitForTimeout(700);
  await expect
    .poll(async () => Number((await zoomLabel.textContent())?.replace("%", "")))
    .toBeGreaterThan(0);
  const before = Number((await zoomLabel.textContent())?.replace("%", ""));
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await page.locator(".research-assistant textarea").fill("так ты приблизь");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.getByText("Приблизил древо.")).toBeVisible();
  await expect
    .poll(async () => Number((await zoomLabel.textContent())?.replace("%", "")))
    .toBeGreaterThan(before);
});
