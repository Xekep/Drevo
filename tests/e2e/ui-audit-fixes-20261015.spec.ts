import { expect, test, type Page } from "@playwright/test";
import { aiChatDetailRoute, aiChatFixture } from "./ai-chat-fixture";

async function openChat(page: Page, unavailable = false) {
  let deletes = 0;
  let rejectDelete = false;
  await page.route("**/api/ai/status", (route) => route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.route("**/api/ai/chats", (route) => route.fulfill({ json: {
    chats: [{ id: "ui-audit-chat", title: "Поиск прадеда", unavailable, updatedAt: "2026-10-15T10:00:00Z" }],
  } }));
  await page.route(aiChatDetailRoute("ui-audit-chat"), (route) => {
    if (route.request().method() === "DELETE") {
      deletes++;
      return route.fulfill(rejectDelete
        ? { status: 503, json: { error: "Временно недоступно" } }
        : { json: { deleted: true } });
    }
    return route.fulfill({ json: aiChatFixture(route.request().url(), "ui-audit-chat", [
      { role: "assistant", content: "Сохранённое исследование" },
    ]) });
  });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await expect(panel.getByRole("button", { name: "Выбрать диалог" })).toBeEnabled();
  return { panel, deletes: () => deletes, reject: (value: boolean) => { rejectDelete = value; } };
}

test("отмена удаления сохраняет сообщения и черновик, подтверждение удаляет диалог", async ({ page }) => {
  const chat = await openChat(page);
  await expect(chat.panel).toContainText("Сохранённое исследование");
  await chat.panel.locator("textarea").fill("Неотправленный вопрос");
  page.once("dialog", (dialog) => dialog.dismiss());
  await chat.panel.getByRole("button", { name: "Удалить диалог", exact: true }).click();
  expect(chat.deletes()).toBe(0);
  await expect(chat.panel).toContainText("Сохранённое исследование");
  await expect(chat.panel.locator("textarea")).toHaveValue("Неотправленный вопрос");
  page.once("dialog", (dialog) => dialog.accept());
  await chat.panel.getByRole("button", { name: "Удалить диалог", exact: true }).click();
  await expect.poll(chat.deletes).toBe(1);
  await expect(chat.panel.locator("article")).toHaveCount(0);
  await expect(chat.panel.locator("textarea")).toHaveValue("");
});

test("недоступный чат не удаляется нажатием строки, отменой или ошибкой API", async ({ page }) => {
  const chat = await openChat(page, true);
  await chat.panel.getByRole("button", { name: "Выбрать диалог" }).click();
  const row = chat.panel.locator(".research-chat-unavailable");
  await row.locator("span").click();
  expect(chat.deletes()).toBe(0);
  const remove = row.getByRole("button", { name: "Удалить недоступный диалог: Поиск прадеда" });
  page.once("dialog", (dialog) => dialog.dismiss());
  await remove.click();
  expect(chat.deletes()).toBe(0);
  await expect(row).toBeVisible();
  chat.reject(true);
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(chat.panel.getByRole("alert")).toContainText("Попробуйте ещё раз");
  await expect(row).toBeVisible();
  await expect(remove).toBeEnabled();
  chat.reject(false);
  page.once("dialog", (dialog) => dialog.accept());
  await remove.click();
  await expect(row).toHaveCount(0);
  await expect(chat.panel.getByRole("alert")).toHaveCount(0);
  expect(chat.deletes()).toBe(2);
});

test("очистка нового чата требует подтверждения и сохраняет отменённый черновик", async ({ page }) => {
  const chat = await openChat(page);
  await chat.panel.getByRole("button", { name: "Выбрать диалог" }).click();
  await chat.panel.getByRole("button", { name: "Новый диалог", exact: true }).click();
  await chat.panel.locator("textarea").fill("Черновик нового исследования");
  const clear = chat.panel.getByRole("button", { name: "Очистить диалог", exact: true });
  page.once("dialog", (dialog) => dialog.dismiss());
  await clear.click();
  await expect(chat.panel.locator("textarea")).toHaveValue("Черновик нового исследования");
  page.once("dialog", (dialog) => dialog.accept());
  await clear.click();
  await expect(chat.panel.locator("textarea")).toHaveValue("");
  expect(chat.deletes()).toBe(0);
});

test("границы полей Yandex AI используют контрастный токен", async ({ page }) => {
  await page.goto("/admin?section=ai");
  const field = page.getByRole("textbox", { name: "API-ключ", exact: true });
  await expect(field).toBeVisible();
  const ratio = await field.evaluate((element) => {
    const style = getComputedStyle(element);
    const luminance = (rgb: string) => rgb.match(/[\d.]+/g)!.slice(0, 3)
      .map(Number).map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
      .reduce((total, v, i) => total + v * [.2126, .7152, .0722][i], 0);
    const values = [luminance(style.borderColor), luminance(style.backgroundColor)].sort((a, b) => b - a);
    return (values[0] + .05) / (values[1] + .05);
  });
  expect(ratio).toBeGreaterThanOrEqual(3);
});

test("даты при переходе к человеку читаются и помещаются в карточку", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/people/e2e-child");
  const card = page.getByTestId("rf__node-e2e-child");
  await expect(card.locator(".portrait-card-years")).toBeAttached();
  // Wait for the navigation camera, rather than accepting the initial fit at a larger zoom.
  await expect.poll(() => card.evaluate((node) => new DOMMatrix(
    getComputedStyle(node.closest(".react-flow__viewport")!).transform,
  ).a)).toBeCloseTo(.55, 2);
  const sizes = await card.evaluate((node) => {
    const zoom = new DOMMatrix(getComputedStyle(node.closest(".react-flow__viewport")!).transform).a;
    const date = node.querySelector(".portrait-card-years")!;
    const font = parseFloat(getComputedStyle(date).fontSize);
    const bounds = node.getBoundingClientRect(), dateBounds = date.getBoundingClientRect();
    const nameBounds = node.querySelector(".portrait-card-info strong")!.getBoundingClientRect();
    return { screenFont: font * zoom,
      fits: dateBounds.left >= bounds.left && dateBounds.right <= bounds.right &&
        dateBounds.bottom <= bounds.bottom && dateBounds.top >= nameBounds.bottom };
  });
  expect(sizes.screenFont).toBeGreaterThanOrEqual(10);
  expect(sizes.fits).toBe(true);
});

test("область приватности остаётся минимум 24px и работает с клавиатуры", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/tree");
  const privacy = page.getByTestId("rf__node-e2e-memorial-person").locator(".flow-privacy");
  await expect(privacy).toBeVisible();
  const target = await privacy.evaluate((button) => {
    const bounds = button.getBoundingClientRect();
    const zoom = new DOMMatrix(getComputedStyle(button.closest(".react-flow__viewport")!).transform).a;
    const pseudo = getComputedStyle(button, "::before");
    const width = parseFloat(pseudo.width) * zoom;
    const height = parseFloat(pseudo.height) * zoom;
    const x = bounds.right - width + 1;
    const y = bounds.top + bounds.height / 2;
    const hit = document.elementFromPoint(x, y);
    return { width, height, x, y, belongs: !!hit && button.contains(hit) };
  });
  expect(target.width).toBeGreaterThanOrEqual(24);
  expect(target.height).toBeGreaterThanOrEqual(24);
  expect(target.belongs).toBe(true);
  await page.mouse.click(target.x, target.y);
  const dialog = page.getByRole("dialog", { name: "Публикация человека в поиске" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await privacy.focus();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeVisible();
});

test("дальний обзор не оставляет крошечные кнопки приватности", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  const zoom = () => page.locator(".react-flow__viewport").evaluate(
    (viewport) => new DOMMatrix(getComputedStyle(viewport).transform).a,
  );
  const smaller = page.getByRole("button", { name: "Уменьшить", exact: true });
  await expect(smaller).toBeEnabled();
  for (let i = 0; i < 16 && await zoom() >= .18; i++) await smaller.click();
  await expect.poll(zoom).toBeLessThan(.18);
  await expect(page.locator(".flow-privacy")).toHaveCount(0);
  const larger = page.getByRole("button", { name: "Увеличить", exact: true });
  for (let i = 0; i < 16 && await zoom() < .25; i++) await larger.click();
  await expect(page.locator(".flow-privacy").first()).toBeAttached();
});
