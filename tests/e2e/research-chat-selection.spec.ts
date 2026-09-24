import { expect, test } from "@playwright/test";

test("choice is invisible to the user and chat picker keeps the original title", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  const submitted: Array<Record<string, unknown>> = [];
  await page.route("**/api/ai/chat/stream", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(body);
    const chatId =
      body.chatId || (submitted.length === 3 ? "chat-two" : "chat-one");
    const answer =
      submitted.length === 1
        ? "Кого вы имеете в виду: [[choose-person:person-42|Иван Петров]]?"
        : "Продолжаю разговор.";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: chat\ndata: ${JSON.stringify({ chatId })}\n\nevent: done\ndata: ${JSON.stringify({ chatId, answer, references: [], suggestionIds: [], uiActions: [], files: [] })}\n\n`,
    });
  });
  let delayChatOne = true;
  await page.route("**/api/ai/chats/chat-one", async (route) => {
    if (delayChatOne) {
      delayChatOne = false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await route.fulfill({
      json: {
        messages: [
          { role: "user", content: "Расскажи об Иване" },
          {
            role: "assistant",
            content:
              "Кого вы имеете в виду: [[choose-person:person-42|Иван Петров]]?",
          },
          { role: "assistant", content: "Продолжаю разговор." },
        ],
      },
    });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  expect(
    (await panel.locator(".research-assistant-messages").boundingBox())?.height,
  ).toBeGreaterThan(150);
  const textarea = panel.locator("textarea");
  await textarea.fill("Расскажи об Иване");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(
    panel.getByRole("button", { name: "Иван Петров" }),
  ).toBeVisible();
  const picker = panel.getByRole("button", { name: "Выбрать диалог" });
  const menu = panel.locator(".research-chat-menu");
  await expect(picker).toContainText("Расскажи об Иване");
  await picker.click();
  await expect(
    menu.getByRole("button", { name: "Расскажи об Иване" }),
  ).toHaveAttribute("aria-current", "true");
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);

  await panel.getByRole("button", { name: "Иван Петров" }).click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1]).toMatchObject({
    message: "",
    selectedPersonId: "person-42",
    chatId: "chat-one",
  });
  await expect(panel.locator("article.is-user")).toHaveCount(1);
  await expect(panel).not.toContainText("personId");
  await expect(picker).toContainText("Расскажи об Иване");

  await picker.click();
  await menu.getByRole("button", { name: "Новый диалог" }).click();
  await expect(picker).toContainText("Новый диалог");
  await textarea.fill("Новый вопрос");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(picker).toContainText("Новый вопрос");
  await picker.click();
  await menu.getByRole("button", { name: "Расскажи об Иване" }).click();
  await expect(picker).toContainText("Расскажи об Иване");
  await picker.click();
  await menu.getByRole("button", { name: "Новый диалог" }).click();
  await expect(picker).toContainText("Новый диалог");
  await page.waitForTimeout(300);
  await expect(picker).toContainText("Новый диалог");
  await picker.click();
  await menu.getByRole("button", { name: "Расскажи об Иване" }).click();
  await expect(picker).toContainText("Расскажи об Иване");
  await expect(panel.locator("article.is-user")).toHaveCount(1);
});

test("dialog history stays compact and searchable", async ({ page }) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({
      json: {
        chats: Array.from({ length: 20 }, (_, index) => ({
          id: `chat-${index}`,
          title: `Разговор ${index}`,
          updatedAt: "2026-09-25",
        })),
      },
    }),
  );
  await page.route("**/api/ai/chats/chat-0", (route) =>
    route.fulfill({ json: { messages: [] } }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const picker = panel.getByRole("button", { name: "Выбрать диалог" });
  await expect(picker).toContainText("Разговор 0");
  await picker.click();
  const menu = panel.locator(".research-chat-menu");
  await expect(menu).toBeVisible();
  const bounds = await menu.boundingBox();
  const triggerBounds = await picker.boundingBox();
  const messagesBounds = await panel
    .locator(".research-assistant-messages")
    .boundingBox();
  expect(bounds).not.toBeNull();
  expect(triggerBounds).not.toBeNull();
  expect(messagesBounds).not.toBeNull();
  expect(bounds!.height).toBeLessThan(275);
  expect(
    Math.abs(bounds!.y - (triggerBounds!.y + triggerBounds!.height + 4)),
  ).toBeLessThan(2);
  expect(
    Math.abs(messagesBounds!.y - (triggerBounds!.y + triggerBounds!.height)),
  ).toBeLessThan(2);
  expect(messagesBounds!.height).toBeGreaterThan(150);
  await menu.getByRole("searchbox", { name: "Поиск диалога" }).fill("17");
  await expect(menu.locator(".research-chat-menu-list button")).toHaveCount(2);
  await expect(menu.getByRole("button", { name: "Разговор 17" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(picker).toBeFocused();
});
