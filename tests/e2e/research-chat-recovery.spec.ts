import { expect, test } from "@playwright/test";

test("terminal stream error clears recovered busy state and remains visible", async ({
  page,
}) => {
  const id = "terminal-chat";
  let busy = false;
  await page.addInitScript((id) => {
    const original = window.fetch.bind(window);
    let output: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    Object.assign(window, {
      failResearchStream() {
        output.enqueue(
          encoder.encode(
            'event: error\ndata: {"error":"Сервис ИИ не смог завершить ответ. Попробуйте повторить запрос."}\n\n',
          ),
        );
        output.close();
      },
    });
    window.fetch = async (input, init) => {
      if (input !== "/api/ai/chat/stream") return original(input, init);
      return new Response(
        new ReadableStream({
          start(controller) {
            output = controller;
            controller.enqueue(
              encoder.encode(
                `event: chat\ndata: ${JSON.stringify({ chatId: id })}\n\n: keep-alive\n\n`,
              ),
            );
          },
        }),
      );
    };
  }, id);
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({
      json: {
        chats: [
          { id, title: "Поиск ГАСО", updatedAt: new Date().toISOString() },
        ],
      },
    }),
  );
  await page.route(`**/api/ai/chats/${id}`, (route) =>
    route.fulfill({
      json: {
        chat: { id, busy },
        messages: busy ? [{ role: "user", content: "Ищи в ГАСО" }] : [],
      },
    }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const picker = panel.getByRole("button", { name: "Выбрать диалог" });
  await expect(picker).toContainText("Поиск ГАСО");
  await panel.locator("textarea").fill("Ищи в ГАСО");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(
    panel.getByRole("button", { name: "Остановить ответ" }),
  ).toBeVisible();
  busy = true;
  await picker.click();
  await panel.getByRole("button", { name: "Новый диалог" }).click();
  await picker.click();
  await panel
    .locator(".research-chat-menu-list")
    .getByRole("button", { name: /Поиск ГАСО/ })
    .click();
  await expect(panel).toContainText("Ищи в ГАСО");
  // Detail loaded busy=true while this tab still owns the stream.
  busy = false;
  await page.evaluate(() =>
    (
      window as typeof window & { failResearchStream(): void }
    ).failResearchStream(),
  );
  await expect(panel.getByRole("alert")).toContainText(
    "Сервис ИИ не смог завершить ответ",
  );
  await expect(
    panel.getByRole("button", { name: "Остановить ответ" }),
  ).toHaveCount(0);
  await expect(panel).not.toContainText("Ответ ещё выполняется на сервере");
  await panel.locator("textarea").fill("Повтори поиск");
  await expect(
    panel.getByRole("button", { name: "Отправить запрос" }),
  ).toBeEnabled();
});

for (const action of ["stop", "delete", "complete"] as const)
  test(`reloaded chat exposes server work and can ${action}`, async ({
    page,
  }) => {
    const id = "f143fc28-694b-42dc-ac44-97df6eac70ef";
    let busy = true,
      deleted = false,
      stops = 0;
    await page.route("**/api/ai/status", (route) =>
      route.fulfill({ json: { enabled: true, streaming: true } }),
    );
    await page.route("**/api/ai/chats", (route) =>
      route.fulfill({
        json: {
          chats: deleted
            ? []
            : [
                {
                  id,
                  title: "Поиск по архиву",
                  updatedAt: new Date().toISOString(),
                },
              ],
        },
      }),
    );
    await page.route(`**/api/ai/chats/${id}`, (route) => {
      if (route.request().method() === "DELETE") {
        deleted = true;
        busy = false;
        return route.fulfill({ json: { deleted: true } });
      }
      return route.fulfill({
        json: {
          chat: { id, busy },
          messages: [
            { role: "user", content: "Поищи в архиве" },
            ...(!busy && !stops
              ? [
                  {
                    role: "assistant",
                    content: "Сохранённый ответ после перезагрузки",
                  },
                ]
              : []),
          ],
        },
      });
    });
    await page.route(`**/api/ai/chats/${id}/stop`, (route) => {
      stops++;
      busy = false;
      return route.fulfill({ json: { busy: false } });
    });
    await page.goto("/tree");
    await page.reload();
    await page
      .getByRole("button", { name: "Открыть ИИ-исследователя" })
      .click();
    const panel = page.locator(".research-assistant");
    await expect(panel).toContainText("Ответ ещё выполняется на сервере");
    const stop = panel.getByRole("button", { name: "Остановить ответ" });
    await expect(stop).toBeVisible();
    if (action === "stop") {
      await stop.click();
      await expect.poll(() => stops).toBe(1);
    } else if (action === "delete") {
      await panel.getByRole("button", { name: "Удалить диалог" }).click();
      await expect.poll(() => deleted).toBe(true);
    } else {
      busy = false;
      await expect(panel).toContainText("Сохранённый ответ после перезагрузки");
    }
    await expect(stop).toHaveCount(0);
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });
