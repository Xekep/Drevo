import { expect, test } from "@playwright/test";

test("заставка закрывает архив до завершения загрузки после входа", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("drevo:entry-sequence", String(Date.now())),
  );
  await page.route("**/api/family?projection=overview", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 450));
    await route.continue();
  });
  await page.goto("/tree", { waitUntil: "domcontentloaded" });
  const entry = page.getByRole("dialog", { name: "Открываем семейный архив" });
  await expect(entry).toBeVisible();
  await expect(entry).not.toHaveClass(/is-ready/);
  await expect(entry).toHaveClass(/is-ready/);
  await expect(entry.locator(".entry-sequence-title strong")).toHaveCSS(
    "animation-name",
    "entry-sequence-title-in",
  );
  await expect(entry.locator(".entry-sequence-title p")).toHaveText(
    "История начинается с семьи.",
  );
  await expect(entry.getByRole("button", { name: "Пропустить" })).toHaveCount(0);
  await expect(entry).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).toBeVisible();
});

test("заставка видна при долгой загрузке и учитывает уменьшенную анимацию", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() =>
    sessionStorage.setItem("drevo:entry-sequence", String(Date.now())),
  );
  let releaseOverview!: () => void;
  const overviewGate = new Promise<void>((resolve) => {
    releaseOverview = resolve;
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    await overviewGate;
    await route.continue();
  });
  await page.goto("/tree", { waitUntil: "domcontentloaded" });
  const entry = page.getByRole("dialog", { name: "Открываем семейный архив" });
  await expect(entry).toBeVisible();
  await expect(entry.getByRole("status")).toHaveText("Открываем архив…");
  await expect(entry.locator(".entry-sequence-title strong")).toHaveCSS(
    "opacity",
    "1",
  );
  await expect(entry.locator(".entry-sequence-title strong")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(entry.locator(".entry-sequence-boughs path").first()).toHaveCSS(
    "stroke-dashoffset",
    "0px",
  );
  await page.keyboard.press("Tab");
  await expect(entry).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(entry).toBeVisible();
  await expect(entry.getByRole("button", { name: "Пропустить" })).toHaveCount(
    0,
  );
  releaseOverview();
  await expect(entry).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(() => sessionStorage.getItem("drevo:entry-sequence")),
    )
    .toBeNull();
});

test("блоки сводки имеют одинаковую ширину на широком экране", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/insights");
  await expect(page.locator(".warnings-card")).toBeVisible();
  const widths = await page
    .locator(
      ".insight-facts:not(.secondary-facts), .insights-more, .insights-columns, .warnings-card",
    )
    .evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().width),
    );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(2);
});

test("сводка объясняет предупреждение и фильтрует результаты", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const child = data.family.people.find(
      (person: { id: string }) => person.id === "e2e-grandchild",
    );
    child.parents = ["e2e-child", "e2e-spouse", "e2e-memorial-person"];
    await route.fulfill({ response, json: data });
  });
  await page.goto("/insights");
  const warning = page.locator(".insight-warning").filter({
    hasText: "Больше двух кровных родителей",
  });
  await expect(warning).toBeVisible();
  await expect(warning.getByText(/Почему:/)).toBeVisible();
  await expect(warning.locator(".insight-warning-people button")).toHaveCount(
    4,
  );
  await page.getByRole("button", { name: /Возможные дубли 0/ }).click();
  await expect(
    page.getByText("В этой категории предупреждений нет."),
  ).toBeVisible();
  await page.getByRole("button", { name: /Нужна проверка/ }).click();
  await expect(warning).toBeVisible();
});

test("Ctrl+колесо масштабирует древо и не меняет масштаб страницы", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  await page.emulateMedia({ reducedMotion: "reduce" });

  const pageZoomBlocked = await page.evaluate(() => {
    const event = new WheelEvent("wheel", {
      ctrlKey: true,
      deltaY: -100,
      bubbles: true,
      cancelable: true,
    });
    return !window.dispatchEvent(event);
  });
  expect(pageZoomBlocked).toBe(true);

  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.evaluate(
    ({ x, y }) => {
      const target = document.elementFromPoint(x, y);
      target?.dispatchEvent(
        new WheelEvent("wheel", {
          ctrlKey: true,
          deltaY: -120,
          clientX: x,
          clientY: y,
          bubbles: true,
          cancelable: true,
        }),
      );
    },
    { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 },
  );
  await expect
    .poll(() => viewport.getAttribute("style"))
    .not.toBe(before);

  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Веер" }).click();
  const fan = page.locator(".fan-chart-svg");
  await expect(fan).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Закрыть веер" }),
  ).toHaveCount(0);
  const outerLayer = page.locator('[data-fan-generation="4"]').first();
  await expect(
    page.locator(
      '[data-fan-generation="4"][data-label-orientation="radial"]',
    ),
  ).not.toHaveCount(0);
  await expect(
    page.locator(
      '[data-fan-generation="3"][data-label-orientation="radial"]',
    ),
  ).not.toHaveCount(0);
  await expect(
    page.locator(
      '[data-fan-generation="2"][data-label-orientation="tangential"]',
    ),
  ).not.toHaveCount(0);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-fan-revealing/);
  await expect(page.locator(".fan-morph-card")).toHaveCount(0);
  await expect(outerLayer).toHaveCSS("opacity", "1");
  await expect(fan).toHaveCSS("animation-name", "none");
});

test("карточки слетаются перед послойным раскрытием веера", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 5_000 });
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Веер" }).click();

  const outerLayer = page.locator('[data-fan-generation="4"]').first();
  await expect(canvas).toHaveClass(/is-fan-revealing/);
  await expect(page.locator(".fan-morph-card").first()).toBeVisible();
  await expect(outerLayer).toHaveCSS("opacity", "0");
  await expect(canvas).not.toHaveClass(/is-fan-revealing/, { timeout: 2_500 });
  await expect(outerLayer).toHaveCSS("opacity", "1");
});

test("веер увеличивается на 2K экране", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 5_000 });
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Веер" }).click();
  const fan = page.locator(".fan-chart-svg");
  await expect(fan).toBeVisible();
  await expect
    .poll(async () => (await fan.boundingBox())?.width || 0)
    .toBeGreaterThan(1450);
});

test("активный веер перестраивается при переходе к родственнику из карточки", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });

  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Веер" }).click();

  const fan = page.locator(".fan-chart");
  await expect(fan).toBeVisible();
  await expect(canvas).not.toHaveClass(/is-fan-revealing/, { timeout: 2_500 });
  const before = await fan.getAttribute("aria-label");

  await page.locator(".inspector-dock .relatives button").first().click();

  await expect(page.locator(".fan-chart-svg")).toBeVisible();
  await expect
    .poll(() => fan.getAttribute("aria-label"))
    .not.toBe(before);
});

test("семья и общие предки центрируют человека, а веер сохраняет ракурс", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  const person = page.getByTestId("rf__node-e2e-child");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  await person.locator(".flow-person-content").click();

  const distanceFromCenter = async () => {
    const [canvasBox, personBox] = await Promise.all([
      canvas.boundingBox(),
      person.boundingBox(),
    ]);
    if (!canvasBox || !personBox) return 1000;
    return Math.hypot(
      personBox.x + personBox.width / 2 - (canvasBox.x + canvasBox.width / 2),
      personBox.y + personBox.height / 2 - (canvasBox.y + canvasBox.height / 2),
    );
  };
  const expectCentered = async () =>
    expect.poll(distanceFromCenter, { timeout: 2_000 }).toBeLessThan(16);

  await page.getByRole("button", { name: "Семья выбранного" }).click();
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expectCentered();

  await page.getByRole("button", { name: "Общие предки" }).click();
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expectCentered();

  const beforeFan = await distanceFromCenter();
  await page.getByRole("button", { name: "Веер" }).click();
  await expect(page.locator(".fan-chart-svg")).toBeVisible();
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(page.locator(".fan-chart-svg")).toHaveCount(0);
  await expect
    .poll(async () => Math.abs((await distanceFromCenter()) - beforeFan))
    .toBeLessThan(2);
});

test("Ctrl+A не выделяет страницу, но работает в полях ввода", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/people");

  await page.getByRole("link", { name: "Люди" }).focus();
  await page.keyboard.press("Control+A");
  const pageSelection = await page.evaluate(() => window.getSelection()?.toString() || "");
  expect(pageSelection).toBe("");

  const search = page.getByRole("combobox", { name: "Найти человека" });
  await search.fill("Тестовый текст");
  await search.press("Control+A");
  const selection = await search.evaluate((input: HTMLInputElement) => ({
    start: input.selectionStart,
    end: input.selectionEnd,
    length: input.value.length,
  }));
  expect(selection.start).toBe(0);
  expect(selection.end).toBe(selection.length);
});

test("Ctrl+колесо не меняет масштаб страницы вне дерева", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  for (const path of ["/people", "/insights"]) {
    await page.goto(path);
    await expect(
      page.getByRole("navigation", { name: "Разделы архива" }),
    ).toBeVisible();
    const blocked = await page.evaluate(() => {
      const event = new WheelEvent("wheel", {
        ctrlKey: true,
        deltaY: -100,
        bubbles: true,
        cancelable: true,
      });
      return !window.dispatchEvent(event);
    });
    expect(blocked).toBe(true);
  }
});

test("действия карточки человека остаются в одном ряду", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/tree");
  await page.getByTestId("rf__node-e2e-memorial-person").click();
  const actions = page.locator(
    ".inspector-heading .inspector-person-actions button",
  );
  await expect(actions.first()).toBeVisible();
  const positions = await actions.evaluateAll((buttons) =>
    buttons.map((button) => button.getBoundingClientRect().top),
  );
  expect(Math.max(...positions) - Math.min(...positions)).toBeLessThan(2);
  const fits = await page
    .locator(".inspector-heading")
    .evaluate((heading) =>
      [...heading.querySelectorAll("button")].every(
        (button) =>
          button.getBoundingClientRect().right <=
          heading.getBoundingClientRect().right,
      ),
    );
  expect(fits).toBe(true);
});

test("на телефоне карточка уступает место открытому ИИ-исследователю", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.goto("/tree");
  await expect(page.getByText("Нужна помощь?", { exact: true })).toBeHidden();
  await page.getByTestId("rf__node-e2e-memorial-person").click();
  const card = page.locator(".inspector-dock");
  await expect(card).toBeVisible();
  await expect(card.locator(".inspector-heading > span")).toBeHidden();
  const dove = card.locator(".memorial-dove");
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await expect(page.locator(".research-assistant")).toBeVisible();
  await expect(card).toBeHidden();
  await expect(dove).toHaveCSS("animation-name", "none");
  await page.getByRole("button", { name: "Закрыть ИИ-исследователя" }).click();
  await expect(card).toBeVisible();
  await expect(dove).toHaveCSS("animation-name", "dove-leave");
});

test("настройка AI Studio содержит ключ, Folder ID и список моделей", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/admin/ai", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch(),
      status = (await response.json()) as Record<string, unknown>,
      usage = status.usage as {
        today: Record<string, unknown>;
        history: Array<Record<string, unknown>>;
        recent: Array<Record<string, unknown>>;
      },
      usageModels = [
        {
          model: "gpt://folder-1/yandexgpt-5.1/latest",
          providerCalls: 2,
          inputTokens: 1200,
          outputTokens: 300,
          totalTokens: 1500,
        },
        {
          model: "gpt://folder-1/deepseek-v4-flash/latest",
          providerCalls: 1,
          inputTokens: 700,
          outputTokens: 500,
          totalTokens: 1200,
        },
      ];
    await route.fulfill({
      response,
      json: {
        ...status,
        usage: {
          ...usage,
          today: {
            ...usage.today,
            inputTokens: 1900,
            outputTokens: 800,
            totalTokens: 2700,
            models: usageModels,
          },
          history: usage.history.map((item, index) =>
            index === usage.history.length - 1
              ? {
                  ...item,
                  inputTokens: 1900,
                  outputTokens: 800,
                  totalTokens: 2700,
                  models: usageModels,
                }
              : {
                  ...item,
                  inputTokens: 0,
                  outputTokens: 0,
                  totalTokens: 0,
                  models: [],
                },
          ),
        },
        models: [
          {
            id: "gpt://folder-1/yandexgpt-5.1/latest",
            label: "yandexgpt-5.1",
            owner: "Yandex",
          },
          {
            id: "gpt://folder-1/deepseek-v4-flash/latest",
            label: "deepseek-v4-flash",
            owner: "Yandex",
          },
        ],
        modelsError: "",
      },
    });
  });
  await page.goto("/admin");
  await expect(page.locator(".admin-stats")).toHaveCount(0);
  await page.getByRole("button", { name: "Yandex AI" }).click();

  await expect(
    page.getByRole("heading", { name: "Yandex AI Studio" }),
  ).toBeVisible();

  const apiKey = page.getByLabel("API-ключ"),
    folderId = page.getByLabel("Folder ID"),
    model = page.getByLabel("Модель");

  await expect(apiKey).toHaveAttribute("type", "password");
  await expect(folderId).toBeVisible();
  await expect(model).toHaveJSProperty("tagName", "SELECT");
  await expect(model.locator("option")).toContainText([
    "yandexgpt-5.1",
    "deepseek-v4-flash",
  ]);
  await expect(
    page.getByRole("img", {
      name: /Расход токенов за последние 14 дней/,
    }),
  ).toBeVisible();
  const tokenPlot = page.locator(".ai-token-plot");
  await expect(tokenPlot.locator("canvas")).toBeVisible();
  await expect(tokenPlot).toHaveAttribute("aria-label", /2.?700/);
  await expect(page.locator(".ai-token-model-legend")).toHaveCount(0);

  await page.getByRole("button", { name: "MCP-токены" }).click();
  const permissions = page.getByLabel("Разрешения");
  await expect(permissions).toHaveValue("all");
  await expect(permissions.locator("option")).toContainText([
    "Все инструменты",
    "Древо и источники",
    "Древо и анализ",
    "Источники и анализ",
    "Только древо",
    "Только источники",
    "Только анализ",
  ]);
  await expect(page.getByLabel("Доступ к древу")).toHaveCount(0);
  await expect(page.getByText("Срок, дней")).not.toBeVisible();
  await page.getByText("Срок и лимит запросов").click();
  await expect(page.getByText("Срок, дней")).toBeVisible();
});

test("ИИ-исследователь не перекрывает навигацию, перетаскивается и рисует Markdown", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({
      json: { enabled: true, canPropose: true, streaming: true },
    }),
  );
  const answer = [
    "## Тестов Иван Петрович ([[person:e2e-memorial-person|Тестов Иван Петрович]])",
    "",
    "| Человек | Год |",
    "| --- | --- |",
    "| Иван | 1900 |",
    "",
    "[[photo:photo-one|Семейный снимок]]",
    "",
    "![Ещё снимок](photo-two)",
    "",
    "```mermaid",
    "graph TD",
    '  A["Тестов Иван Петрович"] --> B["Пётр"]',
    "```",
  ].join("\n");
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/event-stream; charset=utf-8",
      body: `event: delta\ndata: ${JSON.stringify({ text: answer })}\n\nevent: done\ndata: ${JSON.stringify(
        {
          answer,
          references: [
            {
              kind: "person",
              id: "e2e-memorial-person",
              label: "Тестов Иван Петрович",
            },
            { kind: "photo", id: "photo-one", label: "Семейный снимок" },
            { kind: "photo", id: "photo-two", label: "Ещё снимок" },
          ],
          suggestionIds: [],
          uiActions: [{ type: "focus_people", personIds: ["e2e-grandchild"] }],
        },
      )}\n\n`,
    }),
  );
  await page.goto("/tree");
  const trigger = page.getByRole("button", {
      name: "Открыть ИИ-исследователя",
    }),
    controls = page.locator(".flow-camera-tools");
  await expect(trigger).toBeVisible();
  await expect(trigger).not.toContainText("ИИ-исследователь");
  await expect(controls).toBeVisible();
  const [triggerBox, controlsBox] = await Promise.all([
    trigger.boundingBox(),
    controls.boundingBox(),
  ]);
  expect(triggerBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(
    triggerBox!.x < controlsBox!.x
      ? triggerBox!.x + triggerBox!.width <= controlsBox!.x
      : controlsBox!.x + controlsBox!.width <= triggerBox!.x,
  ).toBe(true);
  expect(
    Math.abs(
      triggerBox!.y +
        triggerBox!.height -
        (controlsBox!.y + controlsBox!.height),
    ),
  ).toBeLessThanOrEqual(2);

  await trigger.click();
  const panel = page.locator(".research-assistant"),
    header = panel.locator(":scope > header"),
    before = await panel.boundingBox();
  await expect(
    panel.getByRole("button", { name: "Отправить запрос" }),
  ).toHaveCount(0);
  await expect(header).not.toContainText("Анализирует архив");
  const clearDialog = panel.getByRole("button", { name: "Очистить диалог" });
  await expect(clearDialog).toBeDisabled();
  await expect(panel.locator(".research-assistant-empty button")).toHaveCount(
    0,
  );
  await expect(panel.locator(".research-assistant-empty")).toContainText(
    "Здравствуйте",
  );
  await header.hover();
  await page.mouse.down();
  await page.mouse.move(before!.x - 90, before!.y - 50, { steps: 6 });
  await page.mouse.up();
  const after = await panel.boundingBox();
  expect(Math.abs(after!.x - before!.x)).toBeGreaterThan(30);

  const eastHandle = panel.getByTestId("research-resize-e"),
    eastBox = await eastHandle.boundingBox();
  expect(eastBox).not.toBeNull();
  await page.mouse.move(
    eastBox!.x + eastBox!.width / 2,
    eastBox!.y + eastBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(eastBox!.x + 55, eastBox!.y + eastBox!.height / 2, {
    steps: 6,
  });
  await page.mouse.up();
  const wider = await panel.boundingBox(),
    southHandle = panel.getByTestId("research-resize-s"),
    southBox = await southHandle.boundingBox();
  expect(wider!.width).toBeGreaterThan(after!.width + 25);
  expect(southBox).not.toBeNull();
  await page.mouse.move(
    southBox!.x + southBox!.width / 2,
    southBox!.y + southBox!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(southBox!.x + southBox!.width / 2, southBox!.y + 35, {
    steps: 6,
  });
  await page.mouse.up();
  const resized = await panel.boundingBox();
  expect(resized!.height).toBeGreaterThan(wider!.height + 15);

  await panel.getByRole("textbox").fill("Покажи схему");
  await expect(
    panel.getByRole("button", { name: "Отправить запрос" }),
  ).toBeVisible();
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(
    panel.getByRole("heading", { name: "Тестов Иван Петрович" }),
  ).toBeVisible();
  await expect(panel.locator("table")).toBeVisible();
  const graph = panel.locator(".research-visual canvas");
  await expect(graph).toBeVisible();
  await graph.evaluate((node) => {
    (window as typeof window & { drevoGraphNode?: Element }).drevoGraphNode =
      node;
  });
  await panel.getByRole("textbox").fill("Новый вопрос");
  expect(
    await graph.evaluate(
      (node) =>
        (window as typeof window & { drevoGraphNode?: Element })
          .drevoGraphNode === node,
    ),
  ).toBe(true);
  const headerAfterGraph = await header.boundingBox();
  await page.mouse.move(
    headerAfterGraph!.x + headerAfterGraph!.width / 2,
    headerAfterGraph!.y + headerAfterGraph!.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    headerAfterGraph!.x + headerAfterGraph!.width / 2 - 35,
    headerAfterGraph!.y + headerAfterGraph!.height / 2 - 20,
    { steps: 8 },
  );
  await page.mouse.up();
  expect(
    await graph.evaluate(
      (node) =>
        (window as typeof window & { drevoGraphNode?: Element })
          .drevoGraphNode === node,
    ),
  ).toBe(true);
  const focusedCard = page.getByTestId("rf__node-e2e-grandchild");
  await expect(focusedCard).toHaveClass(/selected/);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-growing/, { timeout: 10_000 });
  await expect
    .poll(async () => {
      const [cardBox, canvasBox] = await Promise.all([
        focusedCard.boundingBox(),
        page.locator(".tree-canvas").boundingBox(),
      ]);
      if (!cardBox || !canvasBox) return 1000;
      return Math.abs(
        cardBox.x + cardBox.width / 2 - (canvasBox.x + canvasBox.width / 2),
      );
    })
    .toBeLessThan(20);
  await expect(panel).toBeVisible();
  await expect(
    panel.getByRole("button", { name: "Тестов Иван Петрович" }),
  ).toHaveCount(1);
  await expect(
    panel.getByRole("button", { name: "Семейный снимок" }),
  ).toBeVisible();
  await expect(panel.getByRole("button", { name: "Ещё снимок" })).toBeVisible();
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(clearDialog).toBeEnabled();
  await clearDialog.click();
  await expect(panel.locator("article")).toHaveCount(0);
  await expect(panel.locator(".research-assistant-empty")).toBeVisible();
  await expect(clearDialog).toBeDisabled();

  await page.getByRole("button", { name: "Закрыть ИИ-исследователя" }).click();
  await page.goto("/photos");
  const galleryTrigger = page.getByRole("button", {
    name: "Открыть ИИ-исследователя",
  });
  const galleryBox = await galleryTrigger.boundingBox();
  expect(galleryBox).not.toBeNull();
  expect(
    page.viewportSize()!.width - galleryBox!.x - galleryBox!.width,
  ).toBeLessThanOrEqual(20);
});

test("администратор выбирает себя в древе и простую область доступа", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let participant = {
    id: "relative-test",
    name: "Участник",
    role: "relative",
    approved: true,
    createdAt: "2026-01-01T00:00:00Z",
    personId: undefined as string | undefined,
    treeAccess: "all",
  };
  const submitted: Record<string, unknown>[] = [];
  await page.route("**/api/users?**", (route) =>
    route.fulfill({ json: { users: [participant], next: null, total: 1 } }),
  );
  await page.route("**/api/users/relative-test", async (route) => {
    const patch = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(patch);
    participant = {
      ...participant,
      personId:
        patch.personId === undefined
          ? participant.personId
          : String(patch.personId),
      treeAccess:
        patch.treeAccess === undefined
          ? participant.treeAccess
          : String(patch.treeAccess),
    };
    await route.fulfill({ json: { user: participant } });
  });
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: { publicTree: false, publicAlbums: false, reverseTimeline: false },
    }),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Участники и роли" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Кто это в древе: Участник" })
    .fill("Иван");
  await page.getByRole("option", { name: /Иван Петрович/ }).click();
  await expect
    .poll(() => submitted[0])
    .toEqual({
      personId: "e2e-memorial-person",
      treeAccess: "all",
    });
  await page
    .getByRole("combobox", { name: "Доступ к древу: Участник" })
    .selectOption("common_ancestors");
  await expect
    .poll(() => submitted[1])
    .toEqual({
      personId: "e2e-memorial-person",
      treeAccess: "common_ancestors",
    });
  await expect(
    page.getByRole("button", { name: "Сохранить доступ" }),
  ).toHaveCount(0);
});

test("поля участника не разъезжаются на разных ширинах", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/users?**", (route) =>
    route.fulfill({
      json: {
        users: [
          {
            id: "layout-test",
            name: "Участник с длинным именем",
            role: "relative",
            approved: true,
            createdAt: "2026-01-01T00:00:00Z",
            treeAccess: "all",
          },
        ],
        next: null,
        total: 1,
      },
    }),
  );
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: { publicTree: false, publicAlbums: false, reverseTimeline: false },
    }),
  );
  for (const width of [1000, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/admin");
    const card = page.locator(".admin-user-row");
    await expect(card).toBeVisible();
    const layout = await card.evaluate((element) => {
      const fields = [...element.children] as HTMLElement[];
      return {
        overflows: element.scrollWidth > element.clientWidth + 1,
        centers: fields.map((field) => {
          const rect = field.getBoundingClientRect();
          return Math.round(rect.top + rect.height / 2);
        }),
      };
    });
    expect(layout.overflows).toBe(false);
    expect(
      Math.max(...layout.centers) - Math.min(...layout.centers),
    ).toBeLessThan(12);
  }
});

test("мобильная админка доступна и не разъезжается", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.route("**/api/users?**", (route) =>
    route.fulfill({
      json: {
        users: [
          {
            id: "mobile-layout-test",
            name: "Участник",
            role: "relative",
            approved: true,
            createdAt: "2026-01-01T00:00:00Z",
            treeAccess: "all",
          },
        ],
        next: null,
        total: 1,
      },
    }),
  );
  await page.goto("/admin");
  await expect(
    page.getByRole("heading", { name: "Участники", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Участники" })).toBeVisible();
  const row = page.locator(".admin-user-row").first();
  await expect(row).toBeVisible();
  await expect(row.getByText("Роль", { exact: true })).toBeVisible();
  await expect(row.getByText("Кто это в древе", { exact: true })).toBeVisible();
  const layout = await page.locator(".admin-page").evaluate((element) => ({
    pageOverflow: document.documentElement.scrollWidth > innerWidth + 1,
    rowOverflow:
      element.querySelector(".admin-user-row")!.scrollWidth >
      element.querySelector(".admin-user-row")!.clientWidth + 1,
  }));
  expect(layout).toEqual({ pageOverflow: false, rowOverflow: false });
  await page.getByRole("button", { name: "Журнал правок" }).click();
  await expect(
    page.getByRole("heading", { level: 1, name: "Журнал правок" }),
  ).toBeVisible();
});

test("семья на древе подсвечивается без режима родства", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/families");
  const group = page.locator(".family-group").first();
  await expect(group).toBeVisible();
  const members =
    (await group.locator(".family-person").count()) +
    (await group.locator(".family-children button").count());
  await group.getByRole("button", { name: "Показать семью на древе" }).click();
  await expect(page).toHaveURL(/\/tree/);
  await expect
    .poll(() => page.locator(".flow-person.is-spotlit").count())
    .toBe(members);
  await expect(
    page.locator(".flow-person.is-outside-spotlight").first(),
  ).toBeVisible();
  await expect(page.locator(".flow-person.is-selected")).toHaveCount(0);
  await expect(page.locator(".comparison-content")).toHaveCount(0);
});

test("выбор двух людей с Shift не выделяет текст на древе", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-spouse")
    .locator(".flow-person-content")
    .click({ modifiers: ["Shift"] });
  await expect
    .poll(() =>
      page
        .locator(".flow-person.is-selected .flow-person-content")
        .evaluateAll(
          (buttons) =>
            new Set(buttons.map((button) => button.getAttribute("aria-label")))
              .size,
        ),
    )
    .toBe(2);
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
});

test("интересные данные не превращаются в длинную ленту карточек", async ({
  page,
}) => {
  await page.goto("/insights");
  await expect(
    page.getByRole("heading", { name: "Сводка архива" }),
  ).toBeVisible();
  await expect(
    page.locator(".insight-facts:not(.secondary-facts) .insight-fact"),
  ).toHaveCount(4);
  await expect(page.locator(".insights-more")).toBeVisible();
  await expect(page.locator(".secondary-facts")).not.toBeVisible();
  await page.locator(".insights-more > summary").click();
  await expect(page.locator(".secondary-facts")).toBeVisible();
});

test("участники загружаются страницами и удаляются из списка", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const participants = Array.from({ length: 45 }, (_, index) => ({
    id: `member-${index}`,
    name: `Участник ${String(index).padStart(2, "0")}`,
    role: "reader",
    approved: true,
    createdAt: "2026-01-01T00:00:00Z",
    treeAccess: "all",
  }));
  const requestedPages: number[] = [];
  await page.route("**/api/users?**", (route) => {
    const start = Number(
      new URL(route.request().url()).searchParams.get("cursor") || 0,
    );
    requestedPages.push(start);
    return route.fulfill({
      json: {
        users: participants.slice(start, start + 20),
        next: start + 20 < participants.length ? String(start + 20) : null,
        total: participants.length,
      },
    });
  });
  await page.route("**/api/users/member-0", (route) => {
    expect(route.request().method()).toBe("DELETE");
    participants.shift();
    return route.fulfill({ json: { deleted: true } });
  });
  await page.route("**/api/settings", (route) =>
    route.fulfill({
      json: { publicTree: false, publicAlbums: false, reverseTimeline: false },
    }),
  );
  await page.goto("/admin");
  await expect(page.locator(".admin-user-row")).toHaveCount(20);
  await page.getByRole("button", { name: "Далее" }).click();
  await expect(page.locator(".admin-user-row")).toHaveCount(20);
  await page.getByRole("button", { name: "Далее" }).click();
  await expect(page.locator(".admin-user-row")).toHaveCount(5);
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page.locator(".admin-user-row")).toHaveCount(20);
  await page.getByRole("button", { name: "Назад" }).click();
  await expect(page.locator(".admin-user-row")).toHaveCount(20);
  expect(requestedPages).toEqual([0, 20, 40, 20, 0]);
  page.once("dialog", (dialog) => dialog.accept());
  await page
    .getByRole("button", { name: "Удалить участника: Участник 00" })
    .click();
  await expect(page.getByText(/Всего участников\s*44/)).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Участник: Участник 00" }),
  ).toHaveCount(0);
});

test("награда добавляется под портретом по названию", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-memorial-person")
    .locator(".flow-person-content")
    .evaluate((card) => (card as HTMLElement).click());
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await expect(
    page.getByRole("heading", { name: "Редактировать человека" }),
  ).toBeVisible();
  await expect(page.locator(".person-editor-portrait-awards")).toBeVisible();
  await expect(page.getByRole("textbox", { name: /ФИО/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Сохранить" })).toBeVisible();
  await expect(page.getByText("Удаление карточки")).toBeVisible();
  const portraitAwards = page.locator(".person-editor-portrait-awards");
  await expect(
    portraitAwards.getByRole("button", {
      name: "Выбрать портрет из фотографий человека",
    }),
  ).toBeVisible();
  await portraitAwards
    .getByRole("button", { name: "Добавить награду" })
    .click();
  await expect(page.getByText("Каталог / страна")).toHaveCount(0);
  const awardName = portraitAwards.getByRole("combobox", { name: "Название" });
  await awardName.fill("За отвагу");
  await expect(portraitAwards.getByRole("listbox")).toBeVisible();
  await portraitAwards.getByRole("option").first().click();
  await portraitAwards
    .locator(".award-inline-actions")
    .getByRole("button", { name: "Добавить" })
    .click();
  await expect(portraitAwards.locator(".award-editor-chip")).toHaveCount(1);
});

test("новый человек начинается с имени, а награды появляются после сохранения", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  await page.getByRole("button", { name: "Человек", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Новый человек" }),
  ).toBeVisible();
  await expect(page.getByRole("textbox", { name: /ФИО/ })).toBeVisible();
  await expect(page.locator(".person-editor-portrait-awards")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Сохранить" })).toBeVisible();
});

test("привязанный человек видит отметку и персональное приветствие", async ({
  page,
}) => {
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({
      json: { enabled: true, canPropose: true, streaming: true },
    }),
  );
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-memorial-person")
    .locator(".flow-person-content")
    .evaluate((card) => (card as HTMLElement).click());
  await expect(page.getByText("Это вы", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  await expect(
    page.getByText("Здравствуйте, Иван!", { exact: true }),
  ).toBeVisible();
});

test("production build opens the archive and navigates without console errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });

  await page.goto("/");
  await expect(page).toHaveTitle(/Древо/);
  await expect(
    page.getByRole("navigation", { name: "Разделы архива" }),
  ).toBeVisible();
  const people = page.getByRole("link", { name: "Люди", exact: true });
  if (!(await people.isVisible()))
    await page.locator('summary[aria-label="Меню проекта"]').click();
  await people.click();
  await expect(page.getByRole("heading", { name: /Люди/ })).toBeVisible();
  expect(errors).toEqual([]);
});

test("initial archive loading uses one quiet progress indicator", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/family**", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 500));
    await route.continue();
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const loader = page.getByRole("status", { name: "Загрузка архива" });
  await expect(loader).toBeVisible();
  await expect(loader.locator(".archive-loader-ring")).toHaveCSS(
    "animation-name",
    "archive-loader-spin",
  );
  await expect(page.getByText(/Открываем .*архив/i)).toHaveCount(0);
  await expect(
    page.getByRole("navigation", { name: "Разделы архива" }),
  ).toBeVisible();
});

test("lazy archive sections use the same quiet progress indicator", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  let sectionRequested = false;
  await page.route(/\/assets\/people-catalog-[^/]+\.js$/, async (route) => {
    sectionRequested = true;
    await new Promise((resolve) => setTimeout(resolve, 700));
    await route.continue();
  });
  await page.goto("/people", { waitUntil: "domcontentloaded" });
  await expect.poll(() => sectionRequested).toBe(true);
  const loader = page.getByRole("status", { name: "Загрузка архива" });
  await expect(loader).toBeVisible();
  await expect(loader.locator(".archive-loader-ring")).toBeVisible();
  await expect(page.getByText(/Открываем раздел/i)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /Люди/ })).toBeVisible();
});

test("mobile archive does not overflow the viewport", async ({ page }) => {
  await page.goto("/tree");
  await expect(
    page.getByRole("navigation", { name: "Разделы архива" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("common ancestors view keeps blood relatives and excludes the spouse", async ({
  page,
}, testInfo) => {
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/);
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .evaluate((card) => (card as HTMLElement).click());
  const dock = page.getByRole("dialog", { name: "Выбранный объект" });
  if (await dock.isVisible())
    await dock.getByRole("button", { name: "Свернуть панель" }).click();
  if (testInfo.project.name === "mobile")
    await page.getByLabel("Область просмотра", { exact: true }).click();
  await page.getByRole("button", { name: "Общие предки" }).click();
  if (testInfo.project.name === "mobile")
    await page.getByLabel("Область просмотра", { exact: true }).click();
  await expect(page.locator(".tree-family-count")).toHaveText("5 из 6");
  if (testInfo.project.name === "desktop") {
    const share = page.getByRole("button", { name: "Поделиться" });
    await expect(share).toBeVisible();
    const aligned = await share.evaluate((button) => {
      const icon = button.querySelector("svg")!.getBoundingClientRect();
      const label = button.querySelector("span")!.getBoundingClientRect();
      return Math.abs(
        icon.top + icon.height / 2 - label.top - label.height / 2,
      );
    });
    expect(aligned).toBeLessThan(2);
  }
  await expect(page.getByTestId("rf__node-e2e-spouse")).toHaveCount(0);
  await expect(page.getByTestId("rf__node-e2e-sibling-child")).toBeAttached();
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(page.locator(".tree-family-count")).toHaveCount(0);
});

test("manual map correction stays available when historical lookup is busy", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const notice =
    "Поиск исторических названий сейчас недоступен. Можно выбрать найденный вариант, указать точку на карте или повторить позже.";
  await page.route("**/api/places/locate**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    await route.fulfill({
      json: { query, candidates: [], notice },
    });
  });

  await page.goto("/places");
  await page
    .getByRole("button", { name: /Москва/ })
    .first()
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: notice }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Указать на карте" }).click();
  await page
    .locator(".leaflet-container")
    .click({ position: { x: 120, y: 120 } });
  await expect(
    page.getByRole("status").filter({ hasText: notice }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Сохранить выбранную точку" }),
  ).toBeVisible();
  await page
    .getByRole("textbox", { name: "Координаты" })
    .fill("53°46′10.5″ N, 67°22′16.4″ E");
  await expect
    .poll(async () =>
      Number(await page.getByRole("spinbutton", { name: "Широта" }).inputValue()),
    )
    .toBeCloseTo(53.7695833333, 7);
  await expect
    .poll(async () =>
      Number(await page.getByRole("spinbutton", { name: "Долгота" }).inputValue()),
    )
    .toBeCloseTo(67.3712222222, 7);
});

test("same-name map candidates show their municipality", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const labels = [
    "Мурзинка, Горноуральский муниципальный округ, Свердловская область, Россия",
    "Мурзинка, Новоуральский городской округ, Свердловская область, Россия",
    "Мурзинка, муниципальный округ Среднеуральск, Свердловская область, Россия",
  ];
  await page.route("**/api/places/locate**", async (route) => {
    const query = new URL(route.request().url()).searchParams.get("q") || "";
    await route.fulfill({
      json: {
        query,
        candidates: query.startsWith("Мурзинка")
          ? labels.map((label, index) => ({
              label,
              name: "Мурзинка",
              lat: 57 + index / 10,
              lon: 60 + index / 10,
            }))
          : [],
      },
    });
  });

  await page.goto("/places");
  await page
    .getByRole("button", { name: /Москва/ })
    .first()
    .click();
  await page
    .getByRole("textbox", { name: "Название для поиска" })
    .fill("Мурзинка, Свердловская область");
  await page.getByRole("button", { name: "Найти" }).click();
  for (const label of labels)
    await expect(page.getByRole("button", { name: label })).toBeVisible();
  await expect(page.locator(".map-candidates li")).toHaveCount(3);
});

test("mobile tree appears fully without branch drawing", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.setViewportSize({ width: 320, height: 720 });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(page.locator(".flow-person")).toHaveCount(7);
  await expect(canvas).not.toHaveClass(/is-growing/);
  await expect(canvas).toHaveAttribute("aria-busy", "false");
  await expect(
    page.locator(".tree-grow-edge .tree-edge-growth-path").first(),
  ).toHaveCSS("display", "none");
  await expect
    .poll(async () =>
      page.locator(".flow-person").evaluateAll((cards) =>
        cards.every((card) => {
          const rect = card.getBoundingClientRect();
          return (
            rect.left >= -1 &&
            rect.right <= innerWidth + 1 &&
            rect.top >= -1 &&
            rect.bottom <= innerHeight + 1
          );
        }),
      ),
    )
    .toBe(true);
});

test("mobile camera moves from the full tree to the linked person", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas"),
    person = page.getByTestId("rf__node-e2e-memorial-person");
  await expect(canvas).not.toHaveClass(/is-growing/);
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([
        canvas.boundingBox(),
        person.boundingBox(),
      ]);
      return a && b ? Math.abs(b.x + b.width / 2 - (a.x + a.width / 2)) : 1000;
    })
    .toBeLessThan(12);
  await expect
    .poll(async () => (await person.boundingBox())?.width || 0)
    .toBeGreaterThanOrEqual(130);
});

test("the initial tree grows from roots toward descendants", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({
      json: { enabled: true, canPropose: true, streaming: true },
    }),
  );
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveClass(/is-growing/);
  const nodes = page.locator(".tree-grow-node");
  await expect(nodes).toHaveCount(7);
  await expect(page.locator(".tree-grow-edge")).toHaveCount(6);
  const delays = await nodes.evaluateAll((items) =>
    items
      .map((item) => getComputedStyle(item).animationDelay)
      .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b)),
  );
  expect(delays).toEqual([
    "0s",
    "0.34s",
    "0.34s",
    "0.37s",
    "0.4s",
    "0.74s",
    "0.77s",
  ]);
  await expect(page.getByTestId("rf__node-e2e-child")).toHaveCSS(
    "animation-delay",
    "0.34s",
  );
  await expect(page.getByTestId("rf__node-e2e-spouse")).toHaveCSS(
    "animation-delay",
    "0.37s",
  );
  await expect(page.getByTestId("rf__node-e2e-sibling")).toHaveCSS(
    "animation-delay",
    "0.4s",
  );
  await expect(nodes.last()).toHaveCSS("animation-name", "tree-branch-reveal");
  await expect(nodes.last()).toHaveCSS("animation-duration", "0.1s");
  const firstGrowthEdge = page
    .locator(".tree-grow-edge .tree-edge-growth-path")
    .first();
  await expect(firstGrowthEdge).toHaveAttribute("pathLength", "1");
  await expect(firstGrowthEdge).toHaveCSS("animation-name", "tree-edge-draw");
  await expect(firstGrowthEdge).toHaveCSS("animation-duration", "0.24s");
  const firstFinalEdge = page
    .locator(".tree-grow-edge .tree-edge-final-path")
    .first();
  await expect(firstFinalEdge).not.toHaveAttribute("pathLength", "1");
  await expect(firstFinalEdge).toHaveCSS(
    "animation-name",
    "none",
  );
  const edgeDelays = await page
    .locator(".tree-grow-edge .tree-edge-growth-path")
    .evaluateAll((items) =>
      items
        .map((item) => getComputedStyle(item).animationDelay)
        .sort((a, b) => Number.parseFloat(a) - Number.parseFloat(b)),
    );
  expect(edgeDelays).toEqual([
    "0.1s",
    "0.1s",
    "0.47s",
    "0.5s",
    "0.5s",
    "0.87s",
  ]);
  const godparent = page.getByRole("button", {
    name: "Связь: Крёстный отец → крестница",
  });
  await expect(godparent).toHaveClass(/tree-grow-edge-label/);
  await expect(godparent).toHaveCSS("animation-name", "tree-edge-label-reveal");
  await expect(godparent).toHaveCSS("animation-delay", "1.11s");

  const pane = page.locator(".react-flow__pane");
  const box = await pane.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width * 0.8;
  const y = box!.y + box!.height * 0.8;
  await expect(canvas).toHaveClass(/is-growing/);
  const viewport = page.locator(".react-flow__viewport");
  const transform = await viewport.getAttribute("style");
  await page.waitForTimeout(120);
  await expect(viewport).toHaveAttribute("style", transform!);
  const firstCard = await page
    .locator(".flow-person-content")
    .first()
    .boundingBox();
  expect(firstCard).not.toBeNull();
  await page.mouse.click(
    firstCard!.x + firstCard!.width / 2,
    firstCard!.y + firstCard!.height / 2,
  );
  await expect(page.locator(".flow-person.is-selected")).toHaveCount(0);
  for (const button of ["left", "right"] as const) {
    await page.mouse.move(x, y);
    await page.mouse.down({ button });
    await page.mouse.move(x - 30, y - 20, { steps: 3 });
    await page.mouse.up({ button });
  }
  await expect(viewport).toHaveAttribute("style", transform!);
  await expect(canvas).toHaveClass(/is-growing/);
  await expect(firstFinalEdge).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  await expect(page.getByText("Нужна помощь?", { exact: true })).toBeVisible();
  const linkedCard = page.getByTestId("rf__node-e2e-memorial-person"),
    canvasAfterGrowth = await canvas.boundingBox(),
    linkedAfterGrowth = await linkedCard.boundingBox();
  expect(canvasAfterGrowth).not.toBeNull();
  expect(linkedAfterGrowth).not.toBeNull();
  expect(
    Math.abs(
      linkedAfterGrowth!.x +
        linkedAfterGrowth!.width / 2 -
        (canvasAfterGrowth!.x + canvasAfterGrowth!.width / 2),
    ),
  ).toBeLessThan(12);
  expect(
    Math.abs(
      linkedAfterGrowth!.y +
        linkedAfterGrowth!.height / 2 -
        (canvasAfterGrowth!.y + canvasAfterGrowth!.height / 2),
    ),
  ).toBeLessThan(12);

  const assistantTrigger = page.getByRole("button", {
      name: "Открыть ИИ-исследователя",
    }),
    cameraTools = page.locator(".flow-camera-tools");
  await expect
    .poll(() =>
      assistantTrigger.evaluate((element) =>
        element.getAnimations().every((animation) => animation.playState !== "running"),
      ),
    )
    .toBe(true);
  const triggerBeforeCard = await assistantTrigger.boundingBox(),
    toolsBeforeCard = await cameraTools.boundingBox();
  expect(triggerBeforeCard).not.toBeNull();
  expect(toolsBeforeCard).not.toBeNull();
  await linkedCard.locator(".flow-person-content").click();
  await expect(
    page.getByRole("complementary", { name: "Выбранный объект" }),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const trigger = await assistantTrigger.boundingBox(),
        tools = await cameraTools.boundingBox();
      if (!trigger || !tools || !triggerBeforeCard || !toolsBeforeCard)
        return 0;
      return Math.abs(
        trigger.x - triggerBeforeCard.x - (tools.x - toolsBeforeCard.x),
      );
    })
    .toBeLessThan(3);
  const toolsAfterCard = await cameraTools.boundingBox();
  expect(toolsAfterCard).not.toBeNull();
  expect(Math.abs(toolsAfterCard!.x - toolsBeforeCard!.x)).toBeGreaterThan(10);
  const finalPaths = page.locator(".tree-grow-edge .tree-edge-final-path");
  await expect(finalPaths).toHaveCount(6);
  expect(
    await finalPaths.evaluateAll((paths) =>
      paths.every((path) => {
        const style = getComputedStyle(path);
        return style.visibility === "visible" && Number(style.opacity) === 1;
      }),
    ),
  ).toBe(true);
  const godparentPath = page.locator(
    ".relationship-godparent .tree-edge-final-path",
  );
  await expect
    .poll(() =>
      godparentPath.evaluate((path) => getComputedStyle(path).strokeDasharray),
    )
    .toContain("5px");
  await expect(
    page.locator(".relationship-godparent .tree-edge-growth-path"),
  ).toHaveCSS("marker-end", "none");
  expect(
    await godparentPath.evaluate((path) => getComputedStyle(path).markerEnd),
  ).not.toBe("none");
  const labelDistance = () => godparent.evaluate((button) => {
    const path = document.querySelector<SVGPathElement>(
      ".relationship-godparent .tree-edge-final-path",
    );
    const matrix = path?.getScreenCTM();
    if (!path || !matrix) return Infinity;
    const rect = button.getBoundingClientRect();
    const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    const length = path.getTotalLength();
    let nearest = Infinity;
    for (let i = 0; i <= 200; i++) {
      const point = path
        .getPointAtLength((length * i) / 200)
        .matrixTransform(matrix);
      nearest = Math.min(
        nearest,
        Math.hypot(point.x - center.x, point.y - center.y),
      );
    }
    return nearest;
  });
  await expect.poll(labelDistance).toBeLessThan(3);
  await expect(page.locator(".flow-person-content strong").first()).toHaveCSS(
    "user-select",
    "none",
  );
  await expect(godparent).toHaveCSS("user-select", "none");
  const nameBox = await page
    .locator(".flow-person-content strong")
    .first()
    .boundingBox();
  expect(nameBox).not.toBeNull();
  await page.mouse.move(nameBox!.x + 2, nameBox!.y + nameBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    nameBox!.x + nameBox!.width - 2,
    nameBox!.y + nameBox!.height / 2,
  );
  await page.mouse.up();
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("");
  await godparent.click();
  await expect(
    page.getByRole("complementary", { name: "Выбранный объект" }),
  ).toBeVisible();

  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 3_000 });
  await expect(page.getByTestId("rf__node-e2e-child")).toHaveCSS("animation-name", "none");
  await expect(godparent).toHaveCSS("animation-name", "none");
});

test("переход к выбранному человеку остаётся плавным", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });

  const person = page.getByTestId("rf__node-e2e-child");
  await person.locator(".flow-person-content").click();

  const pane = page.locator(".react-flow__pane"),
    box = await pane.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width * 0.65, box!.y + box!.height * 0.65);
  await page.mouse.down();
  await page.mouse.move(box!.x + box!.width * 0.25, box!.y + box!.height * 0.25, {
    steps: 4,
  });
  await page.mouse.up();

  const viewport = page.locator(".react-flow__viewport"),
    before = await viewport.getAttribute("style");
  await page.getByRole("button", { name: "К выбранному человеку" }).click();
  await page.waitForTimeout(90);
  const middle = await viewport.getAttribute("style");
  await page.waitForTimeout(520);
  const after = await viewport.getAttribute("style");

  expect(middle).not.toBe(before);
  expect(middle).not.toBe(after);
  expect(after).not.toBe(before);
});

test("collapsing descendants moves the remaining cards smoothly", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });

  const child = page.getByTestId("rf__node-e2e-child");
  const sibling = page.getByTestId("rf__node-e2e-sibling");
  const before = await Promise.all([
    child.boundingBox(),
    sibling.boundingBox(),
  ]);
  await canvas.evaluate((element) => {
    const observed = window as typeof window & {
      treeLayoutSettled?: boolean;
      treeCardMoved?: boolean;
    };
    observed.treeLayoutSettled = false;
    observed.treeCardMoved = false;
    new MutationObserver(() => {
      if (element.classList.contains("is-layout-settling"))
        observed.treeLayoutSettled = true;
    }).observe(element, { attributes: true, attributeFilter: ["class"] });
    element.addEventListener("transitionrun", (event) => {
      if (
        event instanceof TransitionEvent &&
        event.propertyName === "transform" &&
        event.target instanceof Element &&
        event.target.matches(
          "[data-testid='rf__node-e2e-child'], [data-testid='rf__node-e2e-sibling']",
        )
      ) observed.treeCardMoved = true;
    });
  });
  await child.getByRole("button", { name: "Свернуть потомков" }).click();

  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { treeLayoutSettled?: boolean }
  ).treeLayoutSettled)).toBe(true);
  await expect(child).toHaveCSS("transition-duration", "0.44s");
  await expect.poll(() => page.evaluate(() => (
    window as typeof window & { treeCardMoved?: boolean }
  ).treeCardMoved)).toBe(true);

  await expect(canvas).not.toHaveClass(/is-layout-settling/, {
    timeout: 1_000,
  });
  const after = await Promise.all([child.boundingBox(), sibling.boundingBox()]);
  expect(
    after.some(
      (box, index) =>
        !!box &&
        !!before[index] &&
        Math.hypot(box.x - before[index]!.x, box.y - before[index]!.y) > 1,
    ),
  ).toBe(true);
});

test("mobile person card stays below the project menu and starts the memorial flight", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "mobile");
  await page.goto("/tree");
  await page
    .getByRole("button", { name: /Тестов Иван Петрович/ })
    .first()
    .click();

  const card = page.getByRole("dialog", { name: "Выбранный объект" });
  await expect(card).toBeVisible();
  const dove = card.locator(".memorial-dove");
  await expect(dove).toHaveCSS("animation-name", "dove-leave");
  await expect
    .poll(() => dove.evaluate((node) => getComputedStyle(node).transform))
    .not.toBe("none");

  await page.locator('summary[aria-label="Меню проекта"]').click();
  const menu = page.locator(".nav-bottom");
  await expect(menu).toBeVisible();
  expect(
    await menu.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + Math.min(24, rect.height / 2);
      return document.elementFromPoint(x, y)?.closest(".nav-bottom") === node;
    }),
  ).toBe(true);
});

test("face assistant loads the versioned Human models", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  const models = ["blazeface.bin", "facemesh.bin", "faceres.bin"].map((name) =>
    page.waitForResponse((response) =>
      response.url().endsWith(`/models/human-3.3.6/${name}`),
    ),
  );
  await page.goto("/photos");
  for (const response of await Promise.all(models))
    expect(response.ok()).toBe(true);
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
});
