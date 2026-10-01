import { expect, test, type Page, type Locator } from "@playwright/test";

const endpoint = "/api/people/e2e-child/discussion";
async function replaceText(page: Page, editor: Locator, text: string) {
  await editor.click();
  await editor.press("ControlOrMeta+A");
  await page.keyboard.insertText(text);
}
async function openDiscussion(page: Page) {
  await page.goto("/tree");
  await page
    .locator('.flow-person[data-person-id="e2e-child"] .flow-person-content')
    .first()
    .click();
  await page.getByRole("tab", { name: "Обсуждение" }).click();
  const section = page.getByRole("region", { name: "Обсуждение человека" });
  await expect(
    section.getByRole("textbox", { name: "Сообщение для обсуждения" }),
  ).toBeVisible();
  return section;
}

test("comments show Markdown and LaTeX in the editor, support author edits and retain their edit date", async ({
  page,
  request,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const marker = `Воспоминание ${info.project.name} ${Date.now()}`;
  let id: number | undefined;
  try {
    const section = await openDiscussion(page);
    const editor = section.getByRole("textbox", {
      name: "Сообщение для обсуждения",
    });
    await replaceText(page, editor, `**${marker}** и $x^2$ конец`);
    // The formula appears inside the actively edited field, without a second preview pane.
    await expect(
      section.locator(".comment-editor .comment-math-preview .katex"),
    ).toHaveCount(1);
    await section.getByRole("button", { name: "Исходный текст" }).click();
    await expect(editor).toContainText("$x^2$");
    await expect(section.locator(".comment-editor .katex")).toHaveCount(0);
    await section.getByRole("button", { name: "Исходный текст" }).click();
    const source = `## ${marker}\n\n**Проверено** и $x^2$.\n\n- Первый\n- Второй\n\n$$\n\\frac{1}{2}\n$$\n\nПродолжение`;
    await replaceText(page, editor, source);
    await expect(section.locator(".comment-editor .katex")).toHaveCount(2);
    await expect(section.locator(".comment-block-preview h2")).toContainText(
      marker,
    );
    await section
      .locator(".comment-editor")
      .first()
      .screenshot({
        path: info.outputPath("live-comment-editor.png"),
      });
    const sent = page.waitForResponse(
      (response) =>
        response.url().endsWith(endpoint) &&
        response.request().method() === "POST",
    );
    await section
      .getByRole("button", { name: "Отправить", exact: true })
      .click();
    const response = await sent;
    expect(response.status()).toBe(201);
    const original = (await response.json()).item;
    id = original.id;
    expect(original.text).toBe(source);
    expect(original.editedAt).toBeNull();
    let article = section.locator(`article[data-comment-id="${id}"]`);
    await expect(article.locator("h2")).toContainText(marker);
    await expect(article.locator(".katex")).toHaveCount(2);
    await expect(article.locator(".person-discussion-edited")).toHaveCount(0);
    await replaceText(page, editor, "Неотправленный новый комментарий");
    await article
      .getByRole("button", { name: "Редактировать сообщение" })
      .click();
    const editing = section.getByRole("textbox", {
      name: "Редактирование сообщения",
    });
    await replaceText(page, editing, "Отменяемая правка");
    await article.getByRole("button", { name: "Отмена", exact: true }).click();
    await expect(article.locator(".person-discussion-edited")).toHaveCount(0);
    await expect(editor).toContainText("Неотправленный новый комментарий");
    await article
      .getByRole("button", { name: "Редактировать сообщение" })
      .click();
    const editedSource = `**${marker} — исправлено** и $z^2$`;
    await replaceText(page, editing, editedSource);
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith(`${endpoint}/${id}`) &&
        response.request().method() === "PATCH",
    );
    await article
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    const savedResponse = await saved;
    expect(savedResponse.status()).toBe(200);
    const edited = (await savedResponse.json()).item;
    expect(edited.text).toBe(editedSource);
    expect(edited.createdAt).toBe(original.createdAt);
    expect(Date.parse(edited.editedAt)).toBeGreaterThan(
      Date.parse(original.createdAt),
    );
    await expect(article.locator(".person-discussion-edited")).toHaveText(
      "изменено",
    );
    await expect(article.locator(".comment-markdown strong")).toContainText(
      "исправлено",
    );
    await expect(article.locator(".katex")).toHaveCount(1);
    const reopened = await openDiscussion(page);
    article = reopened.locator(`article[data-comment-id="${id}"]`);
    await expect(article.locator(".person-discussion-edited")).toHaveAttribute(
      "datetime",
      edited.editedAt,
    );
    await expect(article.locator(".katex")).toHaveCount(1);
    await reopened.screenshot({
      path: info.outputPath("formatted-comment.png"),
    });
    expect(errors).toEqual([]);
  } finally {
    if (id) await request.delete(`${endpoint}/${id}`);
  }
});

test("a stale edit retains its draft and foreign comments have no edit action", async ({
  page,
  request,
}, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const marker = `Конфликт ${info.project.name} ${Date.now()}`;
  const created = await request.post(endpoint, { data: { text: marker } });
  expect(created.status()).toBe(201);
  const original = (await created.json()).item;
  try {
    await page.route(`**${endpoint}`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      const response = await route.fetch();
      const data = await response.json();
      data.items.push({
        id: 999_999_999,
        text: "Чужой комментарий",
        author: "Другой автор",
        createdAt: new Date().toISOString(),
        editedAt: null,
        canDelete: true,
        canEdit: false,
      });
      await route.fulfill({ response, json: data });
    });
    const section = await openDiscussion(page);
    const foreign = section
      .locator("article")
      .filter({ hasText: "Чужой комментарий" });
    await expect(
      foreign.getByRole("button", { name: "Редактировать сообщение" }),
    ).toHaveCount(0);
    await expect(
      foreign.getByRole("button", { name: "Удалить сообщение" }),
    ).toBeVisible();
    const article = section.locator(
      `article[data-comment-id="${original.id}"]`,
    );
    await article
      .getByRole("button", { name: "Редактировать сообщение" })
      .click();
    const editor = section.getByRole("textbox", {
      name: "Редактирование сообщения",
    });
    const draft = "Мой сохранённый черновик";
    await replaceText(page, editor, draft);
    const remote = `${marker} — другая вкладка`;
    expect(
      (
        await request.patch(`${endpoint}/${original.id}`, {
          data: { text: remote, editedAt: null },
        })
      ).status(),
    ).toBe(200);
    await article
      .getByRole("button", { name: "Сохранить", exact: true })
      .click();
    await expect(section.getByRole("alert")).toContainText("уже изменено");
    await expect(editor).toContainText(draft);
    await expect(article.locator(".person-discussion-conflict")).toContainText(
      remote,
    );
    await article
      .getByRole("button", { name: "Загрузить актуальный текст" })
      .click();
    await expect(editor).toContainText(remote);
    await expect(section.getByRole("alert")).toHaveCount(0);
    await article.getByRole("button", { name: "Отмена", exact: true }).click();
    const stored = (await (await request.get(endpoint)).json()).items.find(
      (item: { id: number }) => item.id === original.id,
    );
    expect(stored.text).toBe(remote);
  } finally {
    await request.delete(`${endpoint}/${original.id}`);
  }
});
