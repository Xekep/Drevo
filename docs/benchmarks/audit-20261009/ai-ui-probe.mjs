import { chromium } from "@playwright/test";
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined,
});
for (const mode of ["graph", "malformed"]) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/api/ai/status", (r) =>
    r.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chat/stream", (r) =>
    r.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({ answer: mode === "graph" ? "```mermaid\ngraph TD\n a[Анна] -->|родитель| b[Иван]\n```" : "[Карточка](#drevo-person-%FF)", references: [], suggestionIds: [], uiActions: [], files: [] })}\n\n`,
    }),
  );
  await page.goto(process.env.DREVO_AUDIT_URL || "http://127.0.0.1:4173/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await page
    .locator(".research-assistant textarea")
    .fill("Проверка отображения");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  if (mode === "graph") {
    await page.locator(".research-visual canvas").waitFor();
    const expand = page.getByRole("button", { name: "Развернуть схему" });
    await expand.focus();
    await page.keyboard.press("Enter");
    await page.getByRole("dialog", { name: "Схема родства" }).waitFor();
    const before = await page.evaluate(() => ({
      active: document.activeElement?.outerHTML?.slice(0, 160),
      inDialog: !!document.activeElement?.closest("[role=dialog]"),
    }));
    await page.keyboard.press("Tab");
    const after = await page.evaluate(() => ({
      active: document.activeElement?.outerHTML?.slice(0, 160),
      inDialog: !!document.activeElement?.closest("[role=dialog]"),
    }));
    console.log(JSON.stringify({ mode, before, after, errors }));
  } else {
    await page
      .getByRole("heading", { name: "Не удалось открыть архив" })
      .waitFor({ timeout: 10000 });
    console.log(
      JSON.stringify({
        mode,
        errors,
        body: (await page.locator("body").innerText()).slice(0, 220),
      }),
    );
  }
  await page.close();
}
await browser.close();
