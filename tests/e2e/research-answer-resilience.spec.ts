import { expect, test } from "@playwright/test";

const damaged =
  "[Повреждённая ссылка](#drevo-person-%FF) · [Неоднозначная ссылка](#drevo-photo-%252F) · [Рабочая ссылка](#drevo-person-e2e-child)";

for (const source of ["stream", "history"] as const) {
  test(`повреждённая ссылка в ${source} не закрывает архив и сохраняет рабочие ссылки`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/api/ai/status", (route) =>
      route.fulfill({ json: { enabled: true, streaming: true } }),
    );
    await page.route("**/api/ai/chats", (route) =>
      route.fulfill({
        json: {
          chats:
            source === "history"
              ? [
                  {
                    id: "damaged-history",
                    title: "Сохранённый диалог",
                    createdAt: "2026-10-09",
                    updatedAt: "2026-10-09",
                  },
                ]
              : [],
        },
      }),
    );
    await page.route("**/api/ai/chats/damaged-history", (route) =>
      route.fulfill({
        json: {
          messages: [{ role: "assistant", content: damaged, references: [] }],
        },
      }),
    );
    await page.route("**/api/ai/chat/stream", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        body: `event: done\ndata: ${JSON.stringify({ answer: damaged, references: [], suggestionIds: [], uiActions: [], files: [] })}\n\n`,
      }),
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/tree");
    await page
      .getByRole("button", { name: "Открыть ИИ-исследователя" })
      .click();
    const panel = page.locator(".research-assistant");
    if (source === "history") {
      await panel.getByRole("button", { name: "Выбрать диалог" }).click();
      await panel.getByRole("button", { name: "Сохранённый диалог" }).click();
    } else {
      await panel.locator("textarea").fill("Покажи ссылки");
      await panel.getByRole("button", { name: "Отправить запрос" }).click();
    }
    await expect(
      panel.getByText("Повреждённая ссылка", { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Повреждённая ссылка" }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Рабочая ссылка" }),
    ).toBeVisible();
    await expect(page.locator(".tree-canvas")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Не удалось открыть архив" }),
    ).toHaveCount(0);
    await panel.getByRole("button", { name: "Рабочая ссылка" }).click();
    await expect(page).toHaveURL(/\/people\/e2e-child$/);
    if (info.project.name === "desktop")
      await expect(page.locator(".inspector-dock")).toBeVisible();
    await expect(panel).toBeVisible();
    expect(errors).toEqual([]);
  });
}

test("повреждённые метаданные ответа изолированы, следующий ответ остаётся рабочим", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  let requests = 0;
  await page.route("**/api/ai/chat/stream", (route) => {
    const damagedMetadata = ++requests === 1;
    return route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({
        answer: damagedMetadata ? "Сведения о родственнике" : damaged,
        references: damagedMetadata
          ? [{ kind: "person", id: "\ud800", label: "Родственник" }]
          : [],
        suggestionIds: [],
        uiActions: [],
        files: [],
      })}\n\n`,
    });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await panel.locator("textarea").fill("Расскажи о родственнике");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(panel.locator(".research-answer-fallback")).toHaveText(
    "Сведения о родственнике",
  );
  await expect(page.locator(".tree-canvas")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Не удалось открыть архив" }),
  ).toHaveCount(0);
  await panel.locator("textarea").fill("Продолжай");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(
    panel.getByRole("button", { name: "Рабочая ссылка" }),
  ).toBeVisible();
});
