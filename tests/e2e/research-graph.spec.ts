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
              "Схема:\n\n```mermaid\ngraph TD\n  a[Анна] --> c[Ребёнок]\n  b[Иван] --> c\n  a --- b\n  c --> d[Внук]\n```",
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
  await expect(page.locator(".research-mermaid svg")).toBeVisible();
  await expect(
    page.locator(".research-assistant article.is-assistant"),
  ).toHaveCount(1);
  await page.getByRole("button", { name: "Развернуть схему" }).click();
  const dialog = page.getByRole("dialog", { name: "Схема родства" });
  await expect(dialog.locator(".research-mermaid-canvas svg")).toBeVisible();
  await dialog.getByRole("button", { name: "Увеличить схему" }).click();
  await expect(dialog).toContainText("125%");
  for (let index = 0; index < 6; index++)
    await dialog.getByRole("button", { name: "Увеличить схему" }).click();
  const canvas = dialog.locator(".research-mermaid-canvas");
  await expect
    .poll(() =>
      canvas.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  const before = await canvas.evaluate((element) => element.scrollTop);
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box!.x + box!.width / 2,
    box!.y + box!.height / 2 - 90,
    { steps: 4 },
  );
  await page.mouse.up();
  await expect
    .poll(() => canvas.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(before);
  await dialog.getByRole("button", { name: "Закрыть схему" }).click();
  await expect(dialog).toHaveCount(0);
});
