import { expect, test } from "@playwright/test";

test("two chats answer in parallel and show their own progress indicators", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    const controllers = new Map<
      string,
      ReadableStreamDefaultController<Uint8Array>
    >();
    const encoder = new TextEncoder();
    Object.assign(window, {
      finishAiChat(id: string) {
        const controller = controllers.get(id);
        controller?.enqueue(
          encoder.encode(
            `event: done\ndata: ${JSON.stringify({ chatId: id, answer: `Ответ ${id}` })}\n\n`,
          ),
        );
        controller?.close();
        controllers.delete(id);
      },
    });
    window.fetch = async (input, init) => {
      if (typeof input !== "string" || !input.endsWith("/api/ai/chat/stream"))
        return original(input, init);
      const body = JSON.parse(String(init?.body || "{}")) as {
        message: string;
      };
      const id = body.message === "Первый" ? "parallel-1" : "parallel-2";
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllers.set(id, controller);
          controller.enqueue(
            encoder.encode(
              `event: chat\ndata: ${JSON.stringify({ chatId: id })}\n\n`,
            ),
          );
          init?.signal?.addEventListener("abort", () => {
            controller.error(new DOMException("aborted", "AbortError"));
            controllers.delete(id);
          });
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream" },
      });
    };
  });
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  for (const id of ["parallel-1", "parallel-2"])
    await page.route(`**/api/ai/chats/${id}`, (route) =>
      route.fulfill({ json: { messages: [] } }),
    );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const picker = panel.getByRole("button", { name: "Выбрать диалог" });
  await panel.locator("textarea").fill("Первый");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(picker).toContainText("Первый");
  await picker.click();
  await panel.getByRole("button", { name: "Новый диалог" }).click();
  await panel.locator("textarea").fill("Второй");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(picker).toContainText("Второй");
  await picker.click();
  const list = panel.locator(".research-chat-menu-list");
  await expect(list.locator(".research-chat-working")).toHaveCount(2);
  await page.keyboard.press("Escape");
  await page.evaluate(() =>
    (window as typeof window & { finishAiChat(id: string): void }).finishAiChat(
      "parallel-1",
    ),
  );
  await expect(panel).not.toContainText("Ответ parallel-1");
  await expect(
    panel.getByRole("button", { name: "Остановить ответ" }),
  ).toBeVisible();
  await page.evaluate(() =>
    (window as typeof window & { finishAiChat(id: string): void }).finishAiChat(
      "parallel-2",
    ),
  );
  await expect(panel).toContainText("Ответ parallel-2");
  await picker.click();
  await list.getByRole("button", { name: /Первый/ }).click();
  await expect(panel).toContainText("Ответ parallel-1");
});

test("switching chats keeps the earlier answer running and isolated", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  let deleted = false;
  await page.route("**/api/ai/chats/chat-2", (route) => {
    deleted = route.request().method() === "DELETE";
    return route.fulfill({ json: { ok: true } });
  });
  let releaseFirst: (() => void) | undefined;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let finishFirst: (() => void) | undefined;
  const firstHandled = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  let requests = 0;
  let firstDelivered = false;
  await page.route("**/api/ai/chat/stream", async (route) => {
    requests++;
    const current = requests;
    if (current === 1) await first;
    try {
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: `event: chat\ndata: ${JSON.stringify({ chatId: `chat-${current}` })}\n\nevent: done\ndata: ${JSON.stringify({ chatId: `chat-${current}`, answer: `Ответ ${current}`, suggestionIds: [] })}\n\n`,
      });
      if (current === 1) firstDelivered = true;
    } catch {
      // The first request may have been aborted by the browser.
    } finally {
      if (current === 1) finishFirst?.();
    }
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await panel.locator("textarea").fill("Первый вопрос");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(
    panel.getByRole("button", { name: "Остановить ответ" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Выбрать диалог" }).click();
  await panel.getByRole("button", { name: "Новый диалог" }).click();
  await expect(
    panel.getByRole("button", { name: "Остановить ответ" }),
  ).toHaveCount(0);
  await panel.locator("textarea").fill("Второй вопрос");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(panel).toContainText("Ответ 2");
  releaseFirst?.();
  await firstHandled;
  expect(firstDelivered).toBe(true);
  await expect(panel).not.toContainText("Ответ 1");
  await panel.getByRole("button", { name: "Выбрать диалог" }).click();
  await expect(panel.locator(".research-chat-menu-list")).toContainText(
    "Первый вопрос",
  );
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "Удалить диалог" }).click();
  await expect(panel.locator("article")).toHaveCount(0);
  expect(deleted).toBe(true);
});

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

test("chat composer grows with text and messages use compact roles", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: 'event: chat\ndata: {"chatId":"chat-compact"}\n\nevent: done\ndata: {"chatId":"chat-compact","answer":"Короткий ответ","suggestionIds":[]}\n\n',
    }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const field = panel.locator("textarea");
  await expect(field).toHaveAttribute("rows", "1");
  expect(
    await field.evaluate((element) => getComputedStyle(element).resize),
  ).toBe("none");
  const initialHeight = (await field.boundingBox())!.height;
  expect(initialHeight).toBeLessThan(45);
  await field.fill("Строка 1\nСтрока 2\nСтрока 3");
  await expect
    .poll(async () => (await field.boundingBox())!.height)
    .toBeGreaterThan(initialHeight);
  const send = panel.getByRole("button", { name: "Отправить запрос" });
  const buttonBox = (await send.boundingBox())!;
  expect(Math.abs(buttonBox.width - buttonBox.height)).toBeLessThan(1);
  await send.click();
  await expect(panel.locator("article.is-assistant")).toContainText(
    "Короткий ответ",
  );
  await expect(panel.locator("article.is-user")).toHaveCount(1);
  await expect(panel.locator("article small")).toHaveCount(0);
  expect(
    await panel
      .locator("article.is-assistant")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgba(0, 0, 0, 0)");
  expect(
    await panel
      .locator("article.is-user")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).not.toBe("rgba(0, 0, 0, 0)");
  await expect
    .poll(async () => (await field.boundingBox())!.height)
    .toBe(initialHeight);
});

test("pending AI edits have visible accept and reject actions", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/research/suggestions", (route) =>
    route.fulfill({
      json: {
        suggestions: [
          {
            id: "suggest-1",
            kind: "person_update",
            personName: "Иван Тестов",
            reason: "Исправить год рождения",
            evidence: [],
            payload: { before: { birth: "1941" }, changes: { birth: "1940" } },
          },
        ],
      },
    }),
  );
  let reviewed = "";
  await page.route("**/api/research/suggestions/suggest-1/reject", (route) => {
    reviewed = route.request().method();
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const suggestion = panel.locator(".research-suggestion");
  await expect(
    suggestion.getByRole("button", { name: "Принять предложение" }),
  ).toBeVisible();
  await expect(
    suggestion.getByRole("button", { name: "Отклонить предложение" }),
  ).toBeVisible();
  await suggestion
    .getByRole("button", { name: "Отклонить предложение" })
    .click();
  await expect(suggestion).toHaveCount(0);
  expect(reviewed).toBe("POST");
});
