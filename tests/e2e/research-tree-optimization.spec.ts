import { expect, test } from "@playwright/test";

test("AI optimizes the displayed layout in a real Worker without changing people or the camera", async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const before = await (await request.get("/api/family")).json();
  await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.route("**/api/ai/chats", route => route.fulfill({ json: { chats: [] } }));
  await page.route("**/api/ai/chat/stream", route => route.fulfill({
    contentType: "text/event-stream; charset=utf-8",
    body: `event: done\ndata: ${JSON.stringify({ answer: "Запускаю оптимизацию.", references: [], suggestionIds: [],
      uiActions: [{ type: "optimize_tree_layout" }], files: [] })}\n\n`,
  }));
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas, JSON.stringify(errors)).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
  await expect(page.getByRole("button", { name: "Вписать видимую часть древа" })).toBeEnabled();
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  // Opening the assistant can resize the viewport; take the baseline afterwards.
  const viewport = canvas.locator(".react-flow__viewport");
  const transform = await viewport.getAttribute("style");
  const ids = await canvas.locator(".react-flow__node").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-id")).sort());
  const workerURLs: string[] = [];
  page.on("worker", worker => workerURLs.push(worker.url()));
  const assistant = page.locator(".research-assistant");
  await assistant.getByRole("textbox").fill("Оптимизируй расположение карточек для печати");
  await assistant.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".archive-toast")).toContainText(/Расположение обновлено|Дополнительного улучшения/);
  expect(workerURLs.some(url => /layout\.worker/.test(url))).toBe(true);
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  expect(await canvas.locator(".react-flow__node").evaluateAll(nodes => nodes.map(n => n.getAttribute("data-id")).sort())).toEqual(ids);
  expect(await viewport.getAttribute("style")).toEqual(transform);
  expect(await (await request.get("/api/family")).json()).toEqual(before);
  expect(errors).toEqual([]);
});
