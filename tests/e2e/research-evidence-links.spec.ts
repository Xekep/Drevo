import { test, expect } from "@playwright/test";
import { queryResearchEvents } from "../../src/domain/research-event-query";
import type { Family } from "../../src/domain/types";

test("a verified event/source link opens the actual record and its source tab without relying on source URLs", async ({
  page,
  context,
}) => {
  const overview = await (
    await page.request.get("/api/family?projection=overview")
  ).json();
  const family = (await (await page.request.get("/api/family")).json())
    .family as Family;
  const person = family.people.find((p) => p.id === "e2e-child")!;
  person.events = [
    ...(person.events || []),
    {
      id: "verified-marriage",
      type: "marriage",
      title: "Архивный брак",
      date: "1991",
      place: "Екатеринбург",
      sources: [
        {
          title: "Метрическая запись для проверки",
          type: "Архив",
          reference: "Ф.6, Оп.13, Д.104",
          note: "Проверяемая привязка к событию",
        },
      ],
    },
  ];
  const evidence = queryResearchEvents(family, {
    criteria: { personId: person.id, titleContains: "Архивный брак" },
  }).events[0].evidence;
  await context.route("**/api/family?projection=overview", (route) =>
    route.fulfill({ json: { ...overview, family, partial: false } }),
  );
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({ answer: `Найден [Архивный брак](${evidence.event.href}), основание — [Метрическая запись](${evidence.sources[0].href}).`, references: [], suggestionIds: [], uiActions: [], files: [] })}\n\n`,
    }),
  );
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const assistant = page.locator(".research-assistant");
  await assistant
    .locator("textarea")
    .fill("Браки в Екатеринбурге с источниками");
  await assistant.getByRole("button", { name: "Отправить запрос" }).click();
  const eventLink = assistant.getByRole("link", { name: "Архивный брак" });
  await expect(eventLink).toHaveAttribute("href", evidence.event.href);
  await expect(
    assistant.getByRole("link", { name: "Метрическая запись" }),
  ).toHaveAttribute("href", evidence.sources[0].href);
  const popupReady = page.waitForEvent("popup");
  await eventLink.click();
  const popup = await popupReady;
  await expect(
    popup.locator(".life-event.research-evidence-target"),
  ).toContainText("Архивный брак");
  await expect(assistant).toBeVisible();
  await popup.close();
  await page.goto(evidence.event.href);
  await expect(
    page.locator(".inspector-dock .life-event.research-evidence-target"),
  ).toContainText("Архивный брак");
  await expect(
    page.locator(".inspector-dock .life-event.research-evidence-target"),
  ).toBeFocused();
  await expect(
    page.locator(".inspector-person-actions > .bookmark-button"),
  ).toBeVisible();
  await page.goto(evidence.sources[0].href);
  await expect(page.getByRole("tab", { name: /^Источники/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(
    page.locator(".inspector-dock .source-card.research-evidence-target"),
  ).toContainText("Метрическая запись для проверки");
  await expect(
    page.locator(".inspector-dock .source-card.research-evidence-target"),
  ).toContainText("Ф.6, Оп.13, Д.104");
});
