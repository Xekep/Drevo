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
  const textarea = panel.locator("textarea");
  await textarea.fill("Расскажи об Иване");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(
    panel.getByRole("button", { name: "Иван Петров" }),
  ).toBeVisible();
  const picker = panel.getByRole("combobox", { name: "Выбрать диалог" });
  await expect(picker).toHaveValue("chat-one");
  await expect(picker.locator('option[value="chat-one"]')).toHaveText(
    "Расскажи об Иване",
  );

  await panel.getByRole("button", { name: "Иван Петров" }).click();
  await expect.poll(() => submitted.length).toBe(2);
  expect(submitted[1]).toMatchObject({
    message: "",
    selectedPersonId: "person-42",
    chatId: "chat-one",
  });
  await expect(panel.locator("article.is-user")).toHaveCount(1);
  await expect(panel).not.toContainText("personId");
  await expect(picker).toHaveValue("chat-one");
  await expect(picker.locator('option[value="chat-one"]')).toHaveText(
    "Расскажи об Иване",
  );

  await picker.selectOption("");
  await expect(picker).toHaveValue("");
  await textarea.fill("Новый вопрос");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(picker).toHaveValue("chat-two");
  await picker.selectOption("chat-one");
  await expect(picker).toHaveValue("chat-one");
  await picker.selectOption("");
  await expect(picker).toHaveValue("");
  await page.waitForTimeout(300);
  await expect(picker).toHaveValue("");
  await picker.selectOption("chat-one");
  await expect(picker).toHaveValue("chat-one");
  await expect(panel.locator("article.is-user")).toHaveCount(1);
});
