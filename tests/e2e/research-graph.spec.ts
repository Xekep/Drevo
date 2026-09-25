import { expect, test } from "@playwright/test";

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
  await expect(
    page.locator(".research-assistant article.is-assistant"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Развернуть схему" }).click();
  const dialog = page.getByRole("dialog", { name: "Схема родства" });
  await expect(dialog.locator(".research-visual-dialog-plot canvas")).toBeVisible();
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
  await expect(dialog.locator(".research-visual-dialog-plot canvas")).toBeVisible();
  await dialog.getByRole("button", { name: "Закрыть схему" }).click();
  await expect(dialog).toHaveCount(0);
});

test("ИИ показывает круговую и временную диаграммы на Canvas", async ({ page }) => {
  const answers = [
    '```mermaid\npie title Родственные ветви\n"Первая": 3\n"Вторая": 2\n```',
    '```mermaid\nxychart-beta\n  title "Люди по годам"\n  x-axis ["1900", "1950", "2000"]\n  bar [1, 4, 8]\n```',
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
