import { expect, test } from "@playwright/test";
import { aiChatDetailRoute, aiChatFixture } from "./ai-chat-fixture.ts";

test("followups retry idempotently, stay in their chat and survive the running answer", async ({ page }, info) => {
  const id = "followup-chat";
  type Stored = { id: number; version: number; role: string; content: string };
  const saved: Stored[] = [];
  const requests: Array<{ requestId: string; message: string }> = [];
  const receipts = new Map<string, Stored>();
  let busy = true;
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.addInitScript(() => {
    const original = window.fetch.bind(window);
    let stream: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    Object.assign(window, {
      finishFollowupFixture() {
        stream.enqueue(encoder.encode(`event: done\ndata: ${JSON.stringify({ chatId: "followup-chat", answer: "Ответ с уточнениями", references: [], suggestionIds: [] })}\n\n`));
        stream.close();
      },
    });
    window.fetch = async (input, init) => {
      if (typeof input !== "string" || !input.endsWith("/api/ai/chat/stream")) return original(input, init);
      return new Response(new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        controller.enqueue(encoder.encode('event: chat\ndata: {"chatId":"followup-chat"}\n\n'));
      } }), { headers: { "Content-Type": "text/event-stream" } });
    };
  });
  await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.route("**/api/ai/chats", route => route.fulfill({ json: { chats: [] } }));
  await page.route(aiChatDetailRoute(id), route => route.fulfill({ json: aiChatFixture(route.request().url(), id, saved, busy) }));
  await page.route(`**/api/ai/chats/${id}/followup`, async route => {
    const request = route.request().postDataJSON() as { requestId: string; message: string };
    requests.push(request);
    let message = receipts.get(request.requestId);
    if (!message) {
      message = { id: saved.length + 1, version: saved.length + 1, role: "user", content: request.message };
      saved.push(message);
      receipts.set(request.requestId, message);
    }
    if (requests.length === 1) return route.fulfill({ status: 500, json: { error: "Ответ сервера потерян. Повторите уточнение." } });
    if (request.message === "Только ближайшие поколения") await held;
    return route.fulfill({ status: 202, json: { accepted: true, message } });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant"), field = panel.locator("textarea");
  const picker = panel.getByRole("button", { name: "Выбрать диалог" });
  await field.fill("Покажи семью");
  saved.push({ id: 1, version: 1, role: "user", content: "Покажи семью" });
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(picker).toContainText("Покажи семью");
  await field.fill("Без дополнительных связей");
  const stop = panel.locator("form").getByRole("button", { name: "Остановить ответ" });
  await expect(stop).toBeVisible();
  const stopBox = (await stop.boundingBox())!;
  expect(stopBox.width).toBe(stopBox.height);
  if (info.project.name === "mobile") expect(stopBox.width).toBeGreaterThanOrEqual(44);
  await panel.getByRole("button", { name: "Отправить уточнение" }).click();
  await expect(panel).toContainText("Ответ сервера потерян");
  await expect(field).toHaveValue("Без дополнительных связей");
  await panel.getByRole("button", { name: "Отправить уточнение" }).click();
  await expect(field).toHaveValue("");
  expect(requests).toHaveLength(2);
  expect(requests[0].requestId).toBe(requests[1].requestId);
  await expect(panel.locator("article.is-user")).toHaveText(["Покажи семью", "Без дополнительных связей"]);
  await expect(stop).toBeVisible();
  await field.fill("Только ближайшие поколения");
  await panel.getByRole("button", { name: "Отправить уточнение" }).click();
  await expect.poll(() => requests.length).toBe(3);
  await picker.click();
  await panel.getByRole("button", { name: "Новый диалог" }).click();
  await expect(field).toHaveValue("");
  release!();
  // Completion of a followup POST in another chat must clear its saved draft too.
  await expect.poll(() => receipts.size).toBe(2);
  await page.evaluate(() => (window as typeof window & { finishFollowupFixture(): void }).finishFollowupFixture());
  busy = false;
  saved.push({ id: 4, version: 4, role: "assistant", content: "Ответ с уточнениями" });
  await expect(panel).not.toContainText("Ответ с уточнениями");
  await picker.click();
  await panel.locator(".research-chat-menu-list").getByRole("button", { name: /Покажи семью/ }).click();
  await expect(field).toHaveValue("");
  await expect(panel.locator("article.is-user")).toHaveText(["Покажи семью", "Без дополнительных связей", "Только ближайшие поколения"]);
  await expect(panel.locator("article.is-assistant")).toHaveCount(1);
  await expect(panel).toContainText("Ответ с уточнениями");
  await expect(stop).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("followups.png") });
});

for (const accepted of [true, false]) {
  test(`a lost followup response is retried after completion without an automatic new turn (accepted=${accepted})`, async ({ page }) => {
    await page.clock.install();
    await page.emulateMedia({ reducedMotion: "reduce" });
    const id = "completed-followup";
    const messages = [{ id: 1, version: 1, role: "user", content: "Покажи семью" }];
    let busy = true, streamRequests = 0;
    const followups: Array<{ requestId: string; message: string }> = [];
    await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
    await page.route("**/api/ai/chats", route => route.fulfill({ json: { chats: [{ id, title: "Семья", updatedAt: "2026-10-24" }] } }));
    await page.route(aiChatDetailRoute(id), route => route.fulfill({ json: aiChatFixture(route.request().url(), id, messages, busy) }));
    await page.route(`**/api/ai/chats/${id}/followup`, route => {
      const request = route.request().postDataJSON() as { requestId: string; message: string };
      followups.push(request);
      if (followups.length === 1) {
        if (accepted) messages.push({ id: 2, version: 2, role: "user", content: request.message });
        return route.fulfill({ status: 500, json: { error: "Не удалось получить ответ. Повторите уточнение." } });
      }
      return accepted
        ? route.fulfill({ status: 202, json: { accepted: true, duplicate: true, message: messages[1] } })
        : route.fulfill({ status: 409, json: { error: "Ответ уже завершён. Уточнение не принято." } });
    });
    await page.route("**/api/ai/chat/stream", route => {
      streamRequests++;
      return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"answer":"Новый отдельный ответ"}\n\n' });
    });
    await page.goto("/tree");
    await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
    const panel = page.locator(".research-assistant"), field = panel.locator("textarea");
    await expect(panel.getByRole("button", { name: "Остановить ответ" })).toBeVisible();
    await field.fill("Только ближайшие поколения");
    await panel.getByRole("button", { name: "Отправить уточнение" }).click();
    await expect(panel).toContainText("Не удалось получить ответ");
    busy = false;
    messages.push({ id: messages.length + 1, version: messages.length + 1, role: "assistant", content: "Ответ завершён" });
    await page.clock.fastForward(2100);
    await expect(panel.getByRole("button", { name: "Остановить ответ" })).toHaveCount(0);
    await panel.getByRole("button", { name: "Отправить запрос" }).click();
    await expect.poll(() => followups.length).toBe(2);
    expect(followups[0].requestId).toBe(followups[1].requestId);
    expect(streamRequests).toBe(0);
    if (accepted) {
      await expect(field).toHaveValue("");
      await expect(panel.locator("article.is-user")).toHaveText(["Покажи семью", "Только ближайшие поколения"]);
    } else {
      await expect(panel).toContainText("Уточнение не принято");
      await expect(field).toHaveValue("Только ближайшие поколения");
      // A rejected late followup becomes a new request only after another explicit click.
      await panel.getByRole("button", { name: "Отправить запрос" }).click();
      await expect.poll(() => streamRequests).toBe(1);
    }
  });
}
