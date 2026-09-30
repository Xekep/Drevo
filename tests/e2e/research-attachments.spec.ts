import { expect, test } from "@playwright/test";

test("paperclip and dropping files share a saved, clearable chat library", async ({
  page,
}, testInfo) => {
  const chatId = "11111111-1111-4111-8111-111111111111";
  type SavedAttachment = {
    name: string;
    url: string;
    size: number;
    type: string;
  };
  let attachments: SavedAttachment[] = [];
  let saved = false;
  let rejected = false;
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({
      json: {
        chats: saved
          ? [{ id: chatId, title: "Изучи файлы", updatedAt: "" }]
          : [],
      },
    }),
  );
  await page.route(`**/api/ai/chats/${chatId}`, (route) => {
    if (route.request().method() === "DELETE") {
      saved = false;
      attachments = [];
      return route.fulfill({ json: { deleted: true } });
    }
    return route.fulfill({
      json: {
        chat: { busy: false },
        messages: [
          { role: "user", content: "Изучи файлы", attachments },
          { role: "assistant", content: "Файлы прочитаны." },
        ],
      },
    });
  });
  await page.route("**/api/ai/chat/stream", (route) => {
    if (rejected)
      return route.fulfill({
        status: 400,
        json: { error: "Вложение отклонено" },
      });
    const body = route.request().postDataJSON();
    expect(body.attachments.map((file: { name: string }) => file.name)).toEqual(
      ["список.csv", "заметки.txt"],
    );
    expect(Buffer.from(body.attachments[0].data, "base64").toString()).toBe(
      "name,year\nИван,1910",
    );
    attachments = body.attachments.map(
      (file: { name: string; data: string }, index: number) => ({
        name: file.name,
        url: `/api/ai/attachments/${chatId}/${index}`,
        size: Buffer.from(file.data, "base64").length,
        type: "text/plain",
      }),
    );
    saved = true;
    return route.fulfill({
      contentType: "text/event-stream",
      body: `event: chat\ndata: ${JSON.stringify({ chatId })}\n\nevent: attachments\ndata: ${JSON.stringify({ attachments })}\n\nevent: done\ndata: ${JSON.stringify({ chatId, answer: "Файлы прочитаны." })}\n\n`,
    });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await expect(
    panel.getByRole("button", { name: "Прикрепить файлы" }),
  ).toBeEnabled();
  const chooser = page.waitForEvent("filechooser");
  await panel.getByRole("button", { name: "Прикрепить файлы" }).click();
  await (
    await chooser
  ).setFiles([
    {
      name: "список.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("name,year\nИван,1910"),
    },
  ]);
  await expect(panel.getByLabel("Прикреплённые файлы")).toContainText(
    "список.csv",
  );
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(
      new File(["Семейная заметка"], "заметки.txt", { type: "text/plain" }),
    );
    return data;
  });
  await panel.dispatchEvent("dragenter", { dataTransfer: transfer });
  await expect(panel.getByText("Перетащите файлы сюда")).toBeVisible();
  await panel
    .locator("textarea")
    .dispatchEvent("drop", { dataTransfer: transfer });
  await expect(panel.getByText("Перетащите файлы сюда")).toHaveCount(0);
  await expect(panel.getByLabel("Прикреплённые файлы")).toContainText(
    "заметки.txt",
  );
  await panel.getByRole("button", { name: "Убрать файл заметки.txt" }).click();
  await expect(
    panel.getByRole("button", { name: "Убрать файл заметки.txt" }),
  ).toHaveCount(0);
  await panel.dispatchEvent("drop", { dataTransfer: transfer });
  await page.screenshot({
    path: testInfo.outputPath("attachment-composer.png"),
  });
  await panel.locator("textarea").fill("Изучи файлы");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(panel).toContainText("Файлы прочитаны.");
  await panel
    .getByRole("button", { name: "Вложения (2)", exact: true })
    .click();
  await expect(
    panel
      .getByRole("region", { name: "Библиотека вложений" })
      .getByRole("link"),
  ).toHaveCount(2);
  await page.screenshot({
    path: testInfo.outputPath("attachment-library.png"),
  });
  await page.reload();
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await panel
    .getByRole("button", { name: "Вложения (2)", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Спросить об этом файле" })
    .first()
    .click();
  await expect(panel.locator("textarea")).toHaveValue(/список.csv/);
  await panel
    .getByRole("button", { name: "Удалить диалог", exact: true })
    .click();
  await panel
    .getByRole("button", { name: "Вложения (0)", exact: true })
    .click();
  await expect(panel).toContainText("Пока нет файлов");
  await expect(
    panel
      .getByRole("region", { name: "Библиотека вложений" })
      .getByRole("link"),
  ).toHaveCount(0);
  rejected = true;
  await panel.getByLabel("Выбрать файлы для ИИ").setInputFiles([
    {
      name: "retry.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("data"),
    },
  ]);
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(panel.getByRole("alert")).toContainText("Вложение отклонено");
  await expect(panel.getByLabel("Прикреплённые файлы")).toContainText(
    "retry.txt",
  );
});

test("ten chats disable creation and unsupported files stay out of the draft", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({
      json: {
        chats: Array.from({ length: 10 }, (_, index) => ({
          id: `chat-${index}`,
          title: `Диалог ${index}`,
          updatedAt: "",
        })),
      },
    }),
  );
  await page.route("**/api/ai/chats/chat-0", (route) =>
    route.fulfill({ json: { chat: { busy: false }, messages: [] } }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await panel.getByRole("button", { name: "Выбрать диалог" }).click();
  await expect(
    panel.getByRole("button", { name: "Новый диалог", exact: true }),
  ).toBeDisabled();
  await expect(panel).toContainText("Диалоги: 10 / 10");
  await page.keyboard.press("Escape");
  await panel.getByLabel("Выбрать файлы для ИИ").setInputFiles([
    {
      name: "run.exe",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("MZ"),
    },
  ]);
  await expect(panel.getByRole("alert")).toContainText(
    "Этот формат не поддерживается",
  );
  await expect(panel.getByLabel("Прикреплённые файлы")).toHaveCount(0);
});

test("disabled AI capabilities reject matching files before uploading, including in library view", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({
      json: {
        enabled: true,
        attachments: { photoAnalysis: false, codeInterpreter: false },
      },
    }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await expect(
    panel.getByRole("button", { name: "Прикрепить файлы" }),
  ).toBeEnabled();
  await panel
    .getByRole("button", { name: "Вложения (0)", exact: true })
    .click();
  await panel
    .getByLabel("Выбрать файлы для ИИ")
    .setInputFiles([
      {
        name: "table.xlsx",
        mimeType: "application/octet-stream",
        buffer: Buffer.from("PK"),
      },
    ]);
  await expect(panel.getByRole("alert")).toContainText(
    "включить Code Interpreter",
  );
  await panel
    .getByLabel("Выбрать файлы для ИИ")
    .setInputFiles([
      {
        name: "photo.png",
        mimeType: "image/png",
        buffer: Buffer.from("image"),
      },
    ]);
  await expect(panel.getByRole("alert")).toContainText(
    "Анализ фотографий отключён",
  );
  await expect(panel.getByLabel("Прикреплённые файлы")).toHaveCount(0);
});
