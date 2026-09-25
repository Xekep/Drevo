import { expect, test } from "@playwright/test";

test.use({ timezoneId: "Pacific/Auckland" });

test("chat sends its browser time zone on each message without sending a client clock", async ({
  page,
}) => {
  const contexts: Array<Record<string, unknown>> = [];
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/ai/chat/stream", (route) => {
    contexts.push(route.request().postDataJSON().context);
    return route.fulfill({
      contentType: "text/event-stream",
      body: 'event: done\ndata: {"answer":"Время уточнено","suggestionIds":[]}\n\n',
    });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  for (let index = 0; index < 2; index++) {
    await page
      .locator(".research-assistant textarea")
      .fill("Какое сегодня число?");
    await page.getByRole("button", { name: "Отправить запрос" }).click();
    await expect(
      page.locator(".research-assistant article.is-assistant"),
    ).toHaveCount(index + 1);
  }
  expect(contexts).toHaveLength(2);
  for (const context of contexts) {
    expect(context.timeZone).toBe("Pacific/Auckland");
    expect(context).not.toHaveProperty("currentDate");
    expect(context).not.toHaveProperty("now");
  }
});
