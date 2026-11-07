import { test, expect, type Page } from "@playwright/test";
import { aiChatDetailRoute, aiChatFixture } from "./ai-chat-fixture.ts";

async function openChat(page: Page) {
  await page.addInitScript(() => {
    const state = { copied: [] as string[], fail: false };
    Object.assign(window, { clipboardProbe: state });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(text: string) {
          if (state.fail) throw new Error("Denied");
          state.copied.push(text);
        },
      },
    });
  });
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({
      json: {
        chats: [
          {
            id: "copy-chat",
            title: "Копирование",
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    }),
  );
  await page.route(aiChatDetailRoute("copy-chat"), (route) =>
    route.fulfill({
      json: aiChatFixture(route.request().url(), "copy-chat", [
        { role: "user", content: "Мой вопрос\nВторая строка" },
        {
          role: "assistant",
          content: "**Ответ**\n\n- Первый пункт\n- Второй пункт",
          activities: ["Проверены источники"],
        },
      ]),
    }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const assistant = page.locator(".research-assistant");
  await expect(assistant.locator("article.is-assistant")).toContainText(
    "Первый пункт",
  );
  return assistant;
}

test("message copy appears on hover/focus and preserves the exact text of each message", async ({
  page,
  isMobile,
}) => {
  const panel = await openChat(page);
  const message = panel.locator(".research-message.is-assistant");
  const actions = message.locator(".research-message-actions");
  if (!isMobile) {
    await panel.locator("textarea").focus();
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await message.hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await page.mouse.move(0, 0);
    await message
      .getByRole("button", { name: "Скопировать сообщение" })
      .focus();
  }
  await expect(actions).toHaveCSS("opacity", "1");
  await message.getByRole("button", { name: "Скопировать сообщение" }).click();
  await expect(
    message.getByRole("button", { name: "Скопировано", exact: true }),
  ).toBeVisible();
  const user = panel.locator(".research-message.is-user");
  if (!isMobile) await user.hover();
  await user.getByRole("button", { name: "Скопировать сообщение" }).click();
  expect(
    await page.evaluate(
      () =>
        (window as typeof window & { clipboardProbe: { copied: string[] } })
          .clipboardProbe.copied,
    ),
  ).toEqual([
    "**Ответ**\n\n- Первый пункт\n- Второй пункт",
    "Мой вопрос\nВторая строка",
  ]);
});

test("clipboard denial is visible and copying can be retried", async ({
  page,
  isMobile,
}) => {
  const panel = await openChat(page);
  const message = panel.locator(".research-message.is-assistant");
  await page.evaluate(() => {
    (
      window as typeof window & { clipboardProbe: { fail: boolean } }
    ).clipboardProbe.fail = true;
  });
  if (!isMobile) await message.hover();
  await message.getByRole("button", { name: "Скопировать сообщение" }).click();
  await expect(message.getByRole("status")).toContainText(
    "Не удалось скопировать сообщение",
  );
  await page.evaluate(() => {
    (
      window as typeof window & { clipboardProbe: { fail: boolean } }
    ).clipboardProbe.fail = false;
  });
  await message.getByRole("button", { name: "Скопировать сообщение" }).click();
  await expect(
    message.getByRole("button", { name: "Скопировано", exact: true }),
  ).toBeVisible();
});
