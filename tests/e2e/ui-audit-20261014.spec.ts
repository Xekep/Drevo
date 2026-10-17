import { expect, test, type Page } from "@playwright/test";

async function fakeGraph(page: Page, direction: "TD" | "LR") {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }));
  await page.route("**/api/ai/chat/stream", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `event: done\ndata: ${JSON.stringify({
      answer: `\`\`\`mermaid\ngraph ${direction}\na["Иван · 1940–2020"] -->|отец| b["Пётр · 1965"]\nb ---|супруги| c["Елена · 1967"]\n\`\`\``,
      references: [], suggestionIds: [], uiActions: [], files: [],
    })}\n\n`,
  }));
}

test("мобильный редактор исключает закрытую сцену из Tab, но сохраняет меню", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/people/e2e-child");
  await page.getByRole("button", { name: "Изменить человека", exact: true }).click();
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Закрыть редактор", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => {
    const active = document.activeElement as HTMLElement;
    const rect = active.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !active.closest(".tree-canvas") && !!hit && active.contains(hit);
  })).toBe(true);
  // The header search may open its own results when it receives focus.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Закрыть редактор", exact: true }).click();
  await expect(canvas).toHaveAttribute("inert", "");
  await page.getByRole("button", { name: "Закрыть панель", exact: true }).click();
  await expect(canvas).not.toHaveAttribute("inert");
});

test("перекрытие мобильной панелью снимается при расширении окна", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/people/e2e-child");
  await expect(page.locator(".tree-canvas")).toHaveAttribute("inert", "");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator(".tree-canvas")).not.toHaveAttribute("inert");
});

for (const failure of ["network", "invalid-json", "server"] as const) {
  test(`вход по почте объясняет ${failure} и сохраняет введённые данные`, async ({ page }) => {
    await page.route("**/api/session", (route) => route.fulfill({ json: {
      user: null, account: null, local: false, email: true, yandex: false, vk: false,
    } }));
    await page.route("**/api/family?projection=overview", (route) =>
      route.fulfill({ status: 401, json: { error: "Войдите в архив" } }));
    await page.route("**/api/auth/email/login", (route) => failure === "network"
      ? route.abort("failed") : route.fulfill(failure === "server"
        ? { status: 503, json: { error: "Synthetic internal service error" } }
        : { body: "<html>upstream failed</html>", contentType: "text/html" }));
    await page.goto("/account");
    await page.getByRole("button", { name: "Войти по почте", exact: true }).click();
    await page.getByLabel("Почта", { exact: true }).fill("ui-regression@example.invalid");
    await page.getByLabel("Пароль", { exact: true }).fill("synthetic-password");
    const submit = page.locator(".login-email-form").getByRole("button", { name: "Войти", exact: true });
    await submit.click();
    await expect(page.locator(".login-email-form [role=alert]")).toContainText(/Попробуйте|попробуйте/);
    await expect(page.locator(".login-email-form [role=alert]")).not.toContainText(/fetch|JSON|Synthetic/);
    await expect(page.getByLabel("Почта", { exact: true })).toHaveValue("ui-regression@example.invalid");
    await expect(submit).toBeEnabled();
  });
}

test("вкладки браузера различают раздел и человека при навигации", async ({ page }) => {
  await page.goto("/people/e2e-child");
  await expect(page).toHaveTitle(/Тестов Пётр Иванович.*Семейный архив$/);
  await page.goto("/people");
  await expect(page).toHaveTitle(/^Люди ·/);
  await page.goto("/photos");
  await expect(page).toHaveTitle(/^Фотографии ·/);
});

for (const direction of ["TD", "LR"] as const) {
  test(`подписи компактной схемы ${direction} не закрывают даты жизни`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await fakeGraph(page, direction);
    await page.goto("/tree");
    await page.getByRole("button", { name: "Открыть ИИ-исследователя", exact: true }).click();
    await page.locator(".research-assistant textarea").fill("Построй схему");
    await page.getByRole("button", { name: "Отправить запрос", exact: true }).click();
    await expect(page.locator(".research-visual canvas")).toBeVisible();
    await expect.poll(async () => page.evaluate(async () => {
      const url = performance.getEntriesByType("resource").find((entry) =>
        /\/echarts-runtime-[^/]+\.js/.test(entry.name))?.name;
      if (!url) return false;
      const module = await import(url);
      type Span = { type: string; style: { text: string }; getComputedTransform(): number[];
        getBoundingRect(): { clone(): { x: number; y: number; width: number; height: number;
          applyTransform(matrix: number[]): void } } };
      const api = Object.values(module).find((value) => typeof (value as {
        getInstanceByDom?: unknown }).getInstanceByDom === "function") as {
          getInstanceByDom(element: Element): { getZr(): { storage: { getDisplayList(): Span[] } } } };
      const chart = api?.getInstanceByDom(document.querySelector(".research-visual-plot")!);
      if (!chart) return false;
      const spans = chart.getZr().storage.getDisplayList().filter((item) => item.type === "tspan")
        .map((item) => { const rect = item.getBoundingRect().clone();
          rect.applyTransform(item.getComputedTransform()); return { text: item.style.text, rect }; });
      const names = spans.filter((item) => /Иван|Пётр|Елена|1940|2020/.test(item.text));
      const edges = spans.filter((item) => /^(отец|супруги)$/.test(item.text));
      return names.some((item) => item.text.includes("1940–2020")) && edges.length === 2 &&
        !names.some((name) => edges.some((edge) =>
          Math.min(name.rect.x + name.rect.width, edge.rect.x + edge.rect.width) > Math.max(name.rect.x, edge.rect.x) &&
          Math.min(name.rect.y + name.rect.height, edge.rect.y + edge.rect.height) > Math.max(name.rect.y, edge.rect.y)));
    })).toBe(true);
    await expect(page.locator(".research-assistant textarea")).toHaveCSS("font-size", "16px");
  });
}
