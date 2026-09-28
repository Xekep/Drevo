import { expect, test } from "@playwright/test";

test("подписи карточек остаются читаемыми при отдалении дерева", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.treePreferences.cardVariant = "classic";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const zoom = page.locator(".flow-camera-tools > span");
  await expect(
    page.getByRole("button", { name: "Уменьшить", exact: true }),
  ).toBeEnabled();
  for (let i = 0; i < 12; i++) {
    const previous = await zoom.textContent();
    const value = parseInt(previous || "0", 10);
    if (value >= 42 && value <= 50) break;
    await page
      .getByRole("button", {
        name: value > 50 ? "Уменьшить" : "Увеличить",
        exact: true,
      })
      .click();
    // React Flow publishes its viewport on a frame. The next click must use
    // that updated viewport instead of racing the previous zero-duration move.
    await expect(zoom).not.toHaveText(previous!);
  }
  await expect
    .poll(async () => parseInt((await zoom.textContent()) || "0", 10))
    .toBeLessThanOrEqual(50);
  expect(
    parseInt((await zoom.textContent()) || "0", 10),
  ).toBeGreaterThanOrEqual(42);
  const card = page
    .locator('.flow-person[data-person-id="e2e-memorial-person"]')
    .first();
  await expect(card.locator(".person-avatar")).toHaveCount(1);
  const geometry = await card.evaluate((element) => {
    const card = element.getBoundingClientRect();
    const node = element.closest(".react-flow__node")!.getBoundingClientRect();
    const surname = element.querySelector("strong")!;
    const scale = card.width / parseFloat(getComputedStyle(element).width);
    return {
      screenFont: parseFloat(getComputedStyle(surname).fontSize) * scale,
      heightDifference: Math.abs(card.height - node.height),
      labelTop: surname.getBoundingClientRect().top - card.top,
      labelBottom: card.bottom - surname.getBoundingClientRect().bottom,
    };
  });
  expect(geometry.screenFont).toBeGreaterThanOrEqual(10);
  expect(geometry.heightDifference).toBeLessThan(1);
  expect(geometry.labelTop).toBeGreaterThanOrEqual(0);
  expect(geometry.labelBottom).toBeGreaterThanOrEqual(0);
  await card
    .getByRole("button", { name: /Тестов Иван Петрович, 1940/ })
    .click();
  await expect(page.locator(".inspector-dock")).toBeVisible();
});

test("tree card and assistant fit common viewport widths without hiding each other", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({
      json: {
        chats: [
          { id: "chat-a", title: "Семейный диалог", updatedAt: "2026-09-25" },
        ],
      },
    }),
  );
  await page.route("**/api/ai/chats/chat-a", (route) =>
    route.fulfill({
      json: {
        messages: [
          { role: "user", content: "Вопрос" },
          { role: "assistant", content: "Ответ" },
        ],
      },
    }),
  );
  for (const width of [320, 360, 390, 768, 1024, 1440, 1920]) {
    await page.setViewportSize({ width, height: width < 500 ? 720 : 900 });
    await page.goto("/people/e2e-memorial-person");
    await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/, {
      timeout: 5_000,
    });
    await expect(page.locator(".inspector-dock")).toBeVisible();
    await page
      .getByRole("button", { name: "Открыть ИИ-исследователя" })
      .click();
    const panel = page.locator(".research-assistant");
    await expect(panel).toBeVisible();
    const geometry = await page.evaluate(() => {
      const p = document
        .querySelector<HTMLElement>(".research-assistant")!
        .getBoundingClientRect();
      const form = document
        .querySelector<HTMLElement>(".research-assistant > form")!
        .getBoundingClientRect();
      const messages = document
        .querySelector<HTMLElement>(".research-assistant-messages")!
        .getBoundingClientRect();
      const inspector = document
        .querySelector<HTMLElement>(".inspector-dock")!
        .getBoundingClientRect();
      return {
        overflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        panelLeft: p.left,
        panelRight: p.right,
        panelTop: p.top,
        panelBottom: p.bottom,
        formTop: form.top,
        messagesTop: messages.top,
        messagesBottom: messages.bottom,
        inspectorLeft: inspector.left,
      };
    });
    expect(geometry.overflow).toBeLessThanOrEqual(1);
    expect(geometry.panelLeft).toBeGreaterThanOrEqual(-1);
    expect(geometry.panelRight).toBeLessThanOrEqual(width + 1);
    expect(geometry.messagesBottom).toBeLessThanOrEqual(geometry.formTop + 1);
    if (width >= 900)
      expect(geometry.panelRight).toBeLessThanOrEqual(
        geometry.inspectorLeft - 12,
      );
  }
  expect(pageErrors).toEqual([]);
});
