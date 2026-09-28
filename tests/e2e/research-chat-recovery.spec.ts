import { expect, test } from "@playwright/test";

for (const action of ["stop", "delete", "complete"] as const)
  test(`reloaded chat exposes server work and can ${action}`, async ({
    page,
  }) => {
    const id = "f143fc28-694b-42dc-ac44-97df6eac70ef";
    let busy = true,
      deleted = false,
      stops = 0;
    await page.route("**/api/ai/status", (route) =>
      route.fulfill({ json: { enabled: true, streaming: true } }),
    );
    await page.route("**/api/ai/chats", (route) =>
      route.fulfill({
        json: {
          chats: deleted
            ? []
            : [
                {
                  id,
                  title: "Поиск по архиву",
                  updatedAt: new Date().toISOString(),
                },
              ],
        },
      }),
    );
    await page.route(`**/api/ai/chats/${id}`, (route) => {
      if (route.request().method() === "DELETE") {
        deleted = true;
        busy = false;
        return route.fulfill({ json: { deleted: true } });
      }
      return route.fulfill({
        json: {
          chat: { id, busy },
          messages: [
            { role: "user", content: "Поищи в архиве" },
            ...(!busy && !stops
              ? [
                  {
                    role: "assistant",
                    content: "Сохранённый ответ после перезагрузки",
                  },
                ]
              : []),
          ],
        },
      });
    });
    await page.route(`**/api/ai/chats/${id}/stop`, (route) => {
      stops++;
      busy = false;
      return route.fulfill({ json: { busy: false } });
    });
    await page.goto("/tree");
    await page.reload();
    await page
      .getByRole("button", { name: "Открыть ИИ-исследователя" })
      .click();
    const panel = page.locator(".research-assistant");
    await expect(panel).toContainText("Ответ ещё выполняется на сервере");
    const stop = panel.getByRole("button", { name: "Остановить ответ" });
    await expect(stop).toBeVisible();
    if (action === "stop") {
      await stop.click();
      await expect.poll(() => stops).toBe(1);
    } else if (action === "delete") {
      await panel.getByRole("button", { name: "Удалить диалог" }).click();
      await expect.poll(() => deleted).toBe(true);
    } else {
      busy = false;
      await expect(panel).toContainText("Сохранённый ответ после перезагрузки");
    }
    await expect(stop).toHaveCount(0);
    await expect(panel.getByRole("alert")).toHaveCount(0);
  });
