import { expect, test } from "@playwright/test";
import type { Family } from "../../src/domain/types.ts";

test("shared tree keeps the orange review border", async ({ page, request }, info) => {
  test.skip(info.project.name !== "desktop");
  const snapshot = await (await request.get("/api/family")).json();
  const family = snapshot.family as Family;
  family.people.find((person) => person.id === "e2e-child")!.needsReview = true;
  const token = "r".repeat(43);
  await page.route(`**/api/shared/${token}`, (route) => route.fulfill({
    json: {
      family,
      serverTime: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
    },
  }));
  await page.goto(`/s/${token}`);
  const card = page.getByTestId("rf__node-e2e-child");
  await expect(card.locator(".flow-person")).toHaveClass(/is-needs-review/);
  await expect(card.locator(".flow-person-content")).toHaveAttribute("aria-label", /требует проверки/);
  expect(await card.locator(".person-avatar").evaluate((avatar) =>
    getComputedStyle(avatar).borderTopColor,
  )).toBe("rgb(215, 123, 24)");
});

test("a review marker survives editing and the assistant temporarily hides its card", async ({
  page,
  request,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({
        answer: "Скрыл отмеченные карточки.",
        references: [],
        suggestionIds: [],
        uiActions: [{ type: "hide_review_people" }],
        files: [],
      })}\n\n`,
    }),
  );
  const card = page.getByTestId("rf__node-e2e-child");
  try {
    await page.goto("/tree");
    await card.locator(".flow-person-content").click();
    await page.locator(".inspector-person-actions .person-edit-button").click();
    await page.getByRole("checkbox", { name: "Требует проверки" }).check();
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/family/changes") &&
        response.request().method() === "POST",
    );
    await page.getByRole("button", { name: "Сохранить", exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(card.locator(".flow-person")).toHaveClass(/is-needs-review/);
    await expect(card.locator(".flow-person-content")).toHaveAttribute(
      "aria-label",
      /требует проверки/,
    );
    expect(
      await card.locator(".person-avatar").evaluate((avatar) =>
        getComputedStyle(avatar).borderTopColor,
      ),
    ).toBe("rgb(215, 123, 24)");
    const snapshot = await (await request.get("/api/family")).json();
    expect(
      (snapshot.family as Family).people.find((person) => person.id === "e2e-child")
        ?.needsReview,
    ).toBe(true);

    await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
    const assistant = page.locator(".research-assistant");
    await assistant.getByRole("textbox").fill("Скрой требующих проверки из древа");
    await assistant.getByRole("button", { name: "Отправить запрос" }).click();
    await expect(page.locator(".tree-filter-status")).toContainText(
      "Без карточек на проверке: 5 из 6",
    );
    await expect(card).toHaveCount(0);
    await assistant.getByRole("button", { name: "Закрыть ИИ-исследователя" }).click();
    await page.getByRole("button", { name: "Всё древо" }).click();
    await expect(card).toBeAttached();
  } finally {
    const current = await (await request.get("/api/family")).json();
    const marked = (current.family as Family).people.find(
      (person) => person.id === "e2e-child",
    );
    if (marked?.needsReview) {
      const cleanup = await request.post("/api/family/changes", {
        headers: { "If-Match": String(current.revision) },
        data: {
          changes: [
            {
              collection: "people",
              id: "e2e-child",
              field: "needsReview",
              before: true,
              after: false,
            },
          ],
        },
      });
      expect(cleanup.status()).toBe(200);
    }
  }
});
