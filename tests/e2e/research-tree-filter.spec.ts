import { expect, test } from "@playwright/test";
import type { Family } from "../../src/domain/types.ts";

test("a filter preserves all other cards, supports an empty result and resets to the full tree", async ({
  page,
  request,
}, info) => {
  const before = await (await request.get("/api/family")).json();
  const family = before.family as Family;
  const kept = family.people
    .filter((person) => person.id !== "e2e-child")
    .map((person) => person.id);
  let call = 0;
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({ answer: "Фильтр применён.", references: [], suggestionIds: [], uiActions: [{ type: "filter_people", personIds: call++ === 0 ? kept : [], label: "Выборка" }], files: [] })}\n\n`,
    }),
  );
  await page.goto("/tree");
  const child = page.getByTestId("rf__node-e2e-child");
  const parent = page.getByTestId("rf__node-e2e-memorial-person");
  await expect(child).toBeAttached();
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const assistant = page.locator(".research-assistant");
  await assistant
    .getByRole("textbox")
    .fill("Оставь всё древо, исключи людей по условию");
  await assistant.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".tree-filter-status")).toContainText(
    `${kept.length} из ${family.people.length}`,
  );
  await expect(child).toHaveCount(0);
  await expect(parent).toBeAttached();
  await assistant.getByRole("textbox").fill("Оставь только совпавших");
  await assistant.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".tree-filter-status")).toContainText(
    `0 из ${family.people.length}`,
  );
  await expect(parent).toHaveCount(0);
  await assistant
    .getByRole("button", { name: "Закрыть ИИ-исследователя" })
    .click();
  await page.screenshot({ path: info.outputPath("empty-tree-filter.png") });
  await page.getByRole("button", { name: "Всё древо", exact: true }).click();
  await expect(child).toBeAttached();
  await expect(parent).toBeAttached();
  await expect(page.locator(".tree-filter-status")).toHaveCount(0);
  expect(await (await request.get("/api/family")).json()).toEqual(before);
});
