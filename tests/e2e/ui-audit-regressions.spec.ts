import { expect, test, type Page } from "@playwright/test";
import PDFDocument from "pdfkit";

async function fakeAssistant(page: Page) {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({
      json: {
        chats: [
          { id: "audit-a", title: "Поиск прадеда" },
          { id: "audit-b", title: "Документы семьи" },
        ],
      },
    }),
  );
  await page.route("**/api/ai/chats/audit-*", (route) =>
    route.fulfill({ json: { messages: [] } }),
  );
}

test("two-person AI graphs keep small round nodes on a narrow screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await fakeAssistant(page);
  await page.route("**/api/ai/chat/stream", route => route.fulfill({
    contentType: "text/event-stream",
    body: `event: done\ndata: ${JSON.stringify({
      answer: '```mermaid\ngraph LR\na[Иван] -->|отец| b[Пётр]\n```\n\n```mermaid\ngraph TD\na[Иван] -->|отец| b[Пётр]\n```',
      references: [], suggestionIds: [], uiActions: [], files: [],
    })}\n\n`,
  }));
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await page.locator(".research-assistant textarea").fill("Покажи схемы");
  await page.getByRole("button", { name: "Отправить запрос" }).click();
  const canvases = page.locator(".research-visual canvas");
  await expect(canvases).toHaveCount(2);
  for (const canvas of await canvases.all()) {
    await expect.poll(() => canvas.evaluate((node: HTMLCanvasElement) => {
      const pixels = node.getContext("2d")!.getImageData(0, 0, node.width, node.height).data;
      let area = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === 95 && pixels[i + 1] === 135 && pixels[i + 2] === 102 && pixels[i + 3] > 200) area++;
      }
      const scale = node.width / node.getBoundingClientRect().width;
      return area / (scale * scale);
    })).toBeGreaterThan(100);
    const greenArea = await canvas.evaluate((node: HTMLCanvasElement) => {
      const pixels = node.getContext("2d")!.getImageData(0, 0, node.width, node.height).data;
      let area = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] === 95 && pixels[i + 1] === 135 && pixels[i + 2] === 102 && pixels[i + 3] > 200) area++;
      }
      const scale = node.width / node.getBoundingClientRect().width;
      return area / (scale * scale);
    });
    expect(greenArea).toBeLessThan(1500);
  }
});

test("resize preserves the tree world centre and mobile offers fit", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  const centre = () =>
    page.locator(".react-flow").evaluate((el) => {
      const bounds = el.getBoundingClientRect();
      const matrix = new DOMMatrix(
        getComputedStyle(el.querySelector(".react-flow__viewport")!).transform,
      );
      return {
        x: (bounds.width / 2 - matrix.e) / matrix.a,
        y: (bounds.height / 2 - matrix.f) / matrix.a,
        zoom: matrix.a,
      };
    });
  const pane = await page.locator(".react-flow__pane").boundingBox();
  await page.mouse.move(pane!.x + 30, pane!.y + 180);
  await page.mouse.down();
  await page.mouse.move(pane!.x + 85, pane!.y + 210, { steps: 4 });
  await page.mouse.up();
  const before = await centre();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(async () => Math.abs((await centre()).x - before.x))
    .toBeLessThan(1);
  await expect
    .poll(async () => Math.abs((await centre()).y - before.y))
    .toBeLessThan(1);
  expect((await centre()).zoom).toBeCloseTo(before.zoom, 4);
  await page
    .getByRole("button", { name: "Вписать видимую часть древа" })
    .click();
  await expect.poll(() => page.locator(".flow-person-content").count()).toBe(6);
});

test("keyboard focus stays above the sticky person save bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/people/e2e-child");
  await page
    .getByRole("button", { name: "Изменить человека", exact: true })
    .click();
  const form = page.locator(".person-editor-form");
  const place = form
    .locator('input[placeholder="Название в то время"]')
    .first();
  await form.locator(".name-entry input").focus();
  for (let index = 0; index < 20; index++) {
    await page.keyboard.press("Tab");
    if (await place.evaluate((el) => el === document.activeElement)) break;
  }
  await expect(place).toBeFocused();
  await expect
    .poll(() =>
      place.evaluate((el) => {
        const footer = el
          .closest("form")!
          .querySelector("footer")!
          .getBoundingClientRect();
        const bounds = el.getBoundingClientRect();
        return (
          bounds.bottom <= footer.top &&
          document.elementFromPoint(
            bounds.x + bounds.width / 2,
            bounds.y + bounds.height / 2,
          ) === el
        );
      }),
    )
    .toBe(true);
});

test("mobile person panel is complementary and leaves navigation available", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/people/e2e-child");
  const dock = page.locator(".inspector-dock");
  await expect(dock).toBeVisible();
  expect(await dock.getAttribute("aria-modal")).toBeNull();
  await page.locator(".nav-account").click();
  await expect(page.locator(".archive-more")).toHaveAttribute("open", "");
});

test("AI chat drafts and files survive switching and deletion is scoped", async ({
  page,
}) => {
  await fakeAssistant(page);
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const select = async (name: string) => {
    await panel.getByRole("button", { name: "Выбрать диалог" }).click();
    await panel.getByRole("button", { name, exact: true }).click();
    await expect(panel.locator("textarea")).toBeEnabled();
  };
  await expect(panel.locator("textarea")).toBeEnabled();
  await select("Поиск прадеда");
  await panel.locator("textarea").fill("Найди документы за 1914 год");
  await panel.locator('input[type="file"]').setInputFiles({
    name: "note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Синтетическая заметка"),
  });
  await expect(panel.locator(".research-attachment-draft")).toHaveCount(1);
  await select("Документы семьи");
  await expect(panel.locator("textarea")).toHaveValue("");
  await panel.locator("textarea").fill("Черновик второго чата");
  await select("Поиск прадеда");
  await expect(panel.locator("textarea")).toHaveValue(
    "Найди документы за 1914 год",
  );
  await expect(panel.locator(".research-attachment-draft")).toContainText(
    "note.txt",
  );
  await panel
    .getByRole("button", { name: "Удалить диалог", exact: true })
    .click();
  await expect(panel.locator("textarea")).toHaveValue("");
  await expect(panel.locator(".research-attachment-draft")).toHaveCount(0);
  await select("Документы семьи");
  await expect(panel.locator("textarea")).toHaveValue("Черновик второго чата");
});

test("new unsent AI chat keeps its draft when existing chats are opened", async ({
  page,
}) => {
  await fakeAssistant(page);
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const select = async (name: string) => {
    await panel.getByRole("button", { name: "Выбрать диалог" }).click();
    await panel.getByRole("button", { name, exact: true }).click();
    await expect(panel.locator("textarea")).toBeEnabled();
  };
  await expect(panel.locator("textarea")).toBeEnabled();
  await select("Новый диалог");
  await panel.locator("textarea").fill("Черновик ещё не созданного диалога");
  await select("Документы семьи");
  await select("Новый диалог");
  await expect(panel.locator("textarea")).toHaveValue(
    "Черновик ещё не созданного диалога",
  );
});

test("AI keyboard entry, mobile focus cycle and close restore focus", async ({
  page,
}) => {
  await fakeAssistant(page);
  await page.goto("/tree");
  const launcher = page.getByRole("button", {
    name: "Открыть ИИ-исследователя",
  });
  await launcher.focus();
  await page.keyboard.press("Enter");
  const panel = page.locator(".research-assistant");
  await expect
    .poll(() => panel.evaluate((el) => el.contains(document.activeElement)))
    .toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toHaveAttribute("aria-modal", "true");
  await expect(panel.locator("textarea")).toBeEnabled();
  await panel.getByRole("button", { name: "Выбрать диалог" }).click();
  await page.keyboard.press("Escape");
  await expect(panel).toBeVisible();
  await panel.locator("textarea").focus();
  for (let index = 0; index < 12; index++) {
    await page.keyboard.press("Tab");
    expect(
      await panel.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await panel.getByRole("button", { name: "Закрыть ИИ-исследователя" }).click();
  await expect(launcher).toBeFocused();
});

test("mobile assistant actions have useful separate touch targets", async ({
  page,
}) => {
  await fakeAssistant(page);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto("/tree");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const actions = await panel.locator("header button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const b = button.getBoundingClientRect();
      return { width: b.width, height: b.height, left: b.left, right: b.right };
    }),
  );
  expect(actions.length).toBe(3);
  for (const item of actions) {
    expect(item.width).toBeGreaterThanOrEqual(44);
    expect(item.height).toBeGreaterThanOrEqual(44);
  }
  for (let index = 1; index < actions.length; index++)
    expect(actions[index].left).toBeGreaterThanOrEqual(
      actions[index - 1].right,
    );
  expect(actions.at(-1)!.right).toBeLessThanOrEqual(
    (await panel.boundingBox())!.x + (await panel.boundingBox())!.width,
  );
});

test("tree zoom increases name size monotonically and names dominate dates", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  let previous = Infinity;
  let crossed = false;
  for (let index = 0; index < 5; index++) {
    const sizes = await page
      .locator(".flow-person")
      .first()
      .evaluate((el) => {
        const zoom = new DOMMatrix(
          getComputedStyle(document.querySelector(".react-flow__viewport")!)
            .transform,
        ).a;
        const name =
          parseFloat(
            getComputedStyle(el.querySelector(".portrait-card-info strong")!)
              .fontSize,
          ) * zoom;
        const date =
          parseFloat(
            getComputedStyle(el.querySelector(".portrait-card-years")!)
              .fontSize,
          ) * zoom;
        return { zoom, name, date };
      });
    expect(sizes.name).toBeLessThanOrEqual(previous + 0.05);
    expect(sizes.name).toBeGreaterThan(sizes.date);
    previous = sizes.name;
    crossed ||= sizes.zoom < 0.52;
    await page.getByRole("button", { name: "Уменьшить", exact: true }).click();
    await page.waitForTimeout(200);
  }
  expect(crossed).toBe(true);
});

test("multi-page PDF adapts to mobile and keeps page on desktop resize", async ({
  page,
}) => {
  const pdf = new PDFDocument({ size: "A4" });
  const chunks: Buffer[] = [];
  pdf.on("data", (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<void>((resolve) => pdf.on("end", resolve));
  pdf.text("UI regression fixture");
  pdf.addPage().text("Page 2");
  pdf.addPage().text("Page 3");
  pdf.end();
  await done;
  const response = await page.request.post("/api/documents", {
    headers: {
      "Content-Type": "application/pdf",
      "X-Document-Metadata": encodeURIComponent(
        JSON.stringify({ title: "UI fixture", personIds: ["e2e-child"] }),
      ),
    },
    data: Buffer.concat(chunks),
  });
  expect(response.status()).toBe(201);
  const document = (await response.json()) as { id: string };
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/documents/${document.id}`);
  const reader = page.frameLocator("iframe.pdf-book-frame");
  await expect(
    reader.locator("br-mode-1up .BRpageimage").first(),
  ).toBeVisible();
  await expect(reader.locator(".BRcurrentpage")).toContainText(
    "Страница 1 из 3",
  );
  await expect
    .poll(
      async () =>
        (await reader.locator(".BRpageimage").first().boundingBox())?.width ||
        0,
    )
    .toBeGreaterThan(300);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(reader.locator("br-mode-2up")).toBeVisible();
  await expect(reader.locator(".BRcurrentpage")).toContainText(
    "Страница 1 из 3",
  );
  await reader.locator(".BRicon.onepg").click();
  await expect(reader.locator("br-mode-1up")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(reader.locator("br-mode-1up")).toBeVisible();
});
