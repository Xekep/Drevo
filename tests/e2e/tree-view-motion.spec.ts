import { expect, test } from "@playwright/test";

test("family, common ancestors and branch changes animate their cards and camera", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 5_000 });
  const child = page.getByTestId("rf__node-e2e-child");
  await child.locator(".flow-person-content").click();
  // Observe within the browser: sequential Playwright round-trips can miss a
  // short-lived exit node when other browser workers are rendering in parallel.
  const observe = () =>
    canvas.evaluateHandle((root) => {
      const state = {
        exited: false,
        entered: false,
        settling: false,
        transforms: new Set<string>(),
        stop: () => {},
      };
      let frame = 0;
      const sample = () => {
        state.settling ||= root.classList.contains("is-layout-settling");
        state.exited ||= Array.from(
          root.querySelectorAll(".tree-exit-node"),
        ).some(
          (node) => getComputedStyle(node).animationName === "tree-layout-exit",
        );
        state.entered ||= !!root.querySelector(".tree-enter-node");
        const viewport = root.querySelector(".react-flow__viewport");
        if (viewport)
          state.transforms.add(getComputedStyle(viewport).transform);
      };
      const observer = new MutationObserver(sample);
      observer.observe(root, {
        subtree: true,
        childList: true,
        attributes: true,
      });
      const tick = () => {
        sample();
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      state.stop = () => {
        observer.disconnect();
        cancelAnimationFrame(frame);
      };
      return state;
    });

  const familyMotion = await observe();
  await page.getByRole("button", { name: "Семья выбранного" }).click();
  await expect
    .poll(() =>
      familyMotion.evaluate(
        (s) => s.exited && s.settling && s.transforms.size >= 3,
      ),
    )
    .toBe(true);
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  await familyMotion.evaluate((s) => s.stop());

  const commonMotion = await observe();
  await page.getByRole("button", { name: "Общие предки" }).click();
  await expect
    .poll(() =>
      commonMotion.evaluate(
        (s) => (s.exited || s.entered) && s.settling && s.transforms.size >= 3,
      ),
    )
    .toBe(true);
  await expect(canvas).not.toHaveClass(/is-layout-settling/);
  await commonMotion.evaluate((s) => s.stop());

  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(canvas).not.toHaveClass(/is-layout-settling/, {
    timeout: 2_000,
  });
  const collapse = child.getByRole("button", { name: "Свернуть потомков" });
  const collapseMotion = await observe();
  await collapse.click();
  await expect
    .poll(() => collapseMotion.evaluate((s) => s.exited && s.settling))
    .toBe(true);
  await collapseMotion.evaluate((s) => s.stop());
});

test("AI launcher moves to the edge when the fan hides camera controls", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 5_000 });
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Веер", exact: true }).click();
  await expect(canvas).toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  const trigger = page.getByRole("button", {
    name: "Открыть ИИ-исследователя",
  });
  await expect
    .poll(async () => {
      const tree = await canvas.boundingBox();
      const button = await trigger.boundingBox();
      return tree && button
        ? tree.x + tree.width - (button.x + button.width)
        : Infinity;
    })
    .toBeLessThan(35);
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(canvas).not.toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  const tools = canvas.locator(".flow-camera-tools");
  await expect(tools).toBeVisible();
  await expect
    .poll(async () => {
      const tool = await tools.boundingBox();
      const button = await trigger.boundingBox();
      return tool && button
        ? Math.abs(button.x + button.width + 8 - tool.x)
        : Infinity;
    })
    .toBeLessThan(12);
});

test("leaving the fan for the same person preserves the tree camera", async ({
  page,
}, testInfo) => {
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 5_000 });
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  if (testInfo.project.name === "mobile")
    await page.getByRole("button", { name: "Свернуть панель" }).click();
  const viewport = page.locator(".react-flow__viewport");
  const camera = async () => {
    const style = await viewport.getAttribute("style");
    const values =
      /translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/.exec(
        style || "",
      );
    if (!values) throw new Error(`Некорректная камера: ${style}`);
    return values.slice(1).map(Number);
  };
  const sameCamera = (actual: number[], expected: number[]) => {
    expect(Math.abs(actual[0] - expected[0])).toBeLessThan(2);
    expect(Math.abs(actual[1] - expected[1])).toBeLessThan(2);
    expect(Math.abs(actual[2] - expected[2])).toBeLessThan(0.002);
  };
  const before = await camera();
  await page.getByRole("button", { name: "Веер", exact: true }).click();
  await expect(canvas).toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  await page.getByRole("button", { name: "Древо", exact: true }).click();
  await expect(canvas).not.toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  await page.waitForTimeout(750);
  sameCamera(await camera(), before);

  await page.getByRole("button", { name: "Веер", exact: true }).click();
  await page.getByRole("button", { name: "Всё древо" }).click();
  await expect(canvas).not.toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  await page.waitForTimeout(750);
  sameCamera(await camera(), before);

  await page.getByRole("button", { name: "Семья выбранного" }).click();
  await page.waitForTimeout(1_200);
  const familyBefore = await camera();
  await page.getByRole("button", { name: "Веер", exact: true }).click();
  await expect(canvas).toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  await page.getByRole("button", { name: "Древо", exact: true }).click();
  await expect(canvas).not.toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  await page.waitForTimeout(750);
  sameCamera(await camera(), familyBefore);

  if (testInfo.project.name === "mobile") return;
  await page.getByRole("button", { name: "Веер", exact: true }).click();
  const fan = page.locator(".fan-chart");
  await fan.locator(".fan-sector.is-known").nth(1).click();
  await expect(fan.locator(".fan-sector.is-selected")).toHaveCount(1);
  await page.getByRole("button", { name: "Древо", exact: true }).click();
  await page.waitForTimeout(750);
  const afterNavigation = await camera();
  expect(
    Math.hypot(
      afterNavigation[0] - familyBefore[0],
      afterNavigation[1] - familyBefore[1],
    ),
  ).toBeGreaterThan(25);
});

test("AI focuses one person without zooming out", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({ answer: "Показываю человека в древе.", references: [], suggestionIds: [], uiActions: [{ type: "focus_people", personIds: ["e2e-grandchild"] }] })}\n\n`,
    }),
  );
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/, {
    timeout: 5_000,
  });
  const viewport = page.locator(".react-flow__viewport");
  await page
    .locator(".flow-camera-tools")
    .getByRole("button", { name: "Увеличить" })
    .click();
  await page.waitForTimeout(400);
  const before = await viewport.evaluate((element) =>
    Number(element.getAttribute("style")?.match(/scale\(([^)]+)\)/)?.[1] || 0),
  );
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await panel.getByRole("textbox").fill("Покажи человека в древе");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  const card = page.getByTestId("rf__node-e2e-grandchild");
  await expect(card).toHaveClass(/selected/);
  await expect
    .poll(async () => {
      const [cardBox, canvasBox] = await Promise.all([
        card.boundingBox(),
        page.locator(".tree-canvas").boundingBox(),
      ]);
      return cardBox && canvasBox
        ? Math.abs(
            cardBox.x + cardBox.width / 2 - (canvasBox.x + canvasBox.width / 2),
          )
        : Infinity;
    })
    .toBeLessThan(20);
  const after = await viewport.evaluate((element) =>
    Number(element.getAttribute("style")?.match(/scale\(([^)]+)\)/)?.[1] || 0),
  );
  expect(after).toBeGreaterThanOrEqual(before - 0.02);
  await expect(panel).toBeVisible();
});

test("opening another card after personal intro keeps the camera in place", async ({
  page,
}) => {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  const self = page.getByTestId("rf__node-e2e-memorial-person");
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 5_000 });
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([
        canvas.boundingBox(),
        self.boundingBox(),
      ]);
      return a && b
        ? Math.abs(b.x + b.width / 2 - (a.x + a.width / 2))
        : Infinity;
    })
    .toBeLessThan(15);
  await page.waitForTimeout(750);
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  const other = page.getByTestId("rf__node-e2e-spouse");
  await other.locator(".flow-person-content").click();
  await expect(page).toHaveURL(/\/people\/e2e-spouse$/);
  await expect(other).toHaveClass(/selected/);
  await page.waitForTimeout(800);
  expect(await viewport.getAttribute("style")).toBe(before);
});

test("opening a card after a profile link does not restore its old focus", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.goto("/people/e2e-memorial-person");
  const canvas = page.locator(".tree-canvas");
  const self = page.getByTestId("rf__node-e2e-memorial-person");
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 5_000 });
  await expect
    .poll(async () => {
      const [a, b] = await Promise.all([
        canvas.boundingBox(),
        self.boundingBox(),
      ]);
      return a && b
        ? Math.abs(b.x + b.width / 2 - (a.x + a.width / 2))
        : Infinity;
    })
    .toBeLessThan(20);
  await page.waitForTimeout(750);
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  const other = page.getByTestId("rf__node-e2e-spouse");
  await other.locator(".flow-person-content").click();
  await expect(page).toHaveURL(/\/people\/e2e-spouse$/);
  await expect(other).toHaveClass(/selected/);
  await page.waitForTimeout(800);
  expect(await viewport.getAttribute("style")).toBe(before);
});

test("clicking a card during the personal camera move cancels that move", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveClass(/is-growing/, { timeout: 5_000 });
  const viewport = page.locator(".react-flow__viewport");
  await page.waitForFunction(
    () => {
      const canvas = document.querySelector(".tree-canvas");
      const viewport = document.querySelector<HTMLElement>(
        ".react-flow__viewport",
      );
      if (!canvas || !viewport) return false;
      const state = window as typeof window & { __cameraSample?: string };
      const current = viewport.style.transform;
      const moving =
        !canvas.classList.contains("is-growing") &&
        state.__cameraSample !== undefined &&
        state.__cameraSample !== current;
      state.__cameraSample = current;
      return moving;
    },
    null,
    { timeout: 10_000, polling: "raf" },
  );
  await page
    .getByTestId("rf__node-e2e-spouse")
    .locator(".flow-person-content")
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page).toHaveURL(/\/people\/e2e-spouse$/);
  const afterClick = await viewport.getAttribute("style");
  await page.waitForTimeout(750);
  expect(await viewport.getAttribute("style")).toBe(afterClick);
});

test("branches collapse and expand inside an AI-filtered tree", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  await page.route("**/api/ai/chat/stream", (route) =>
    route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({ answer: "Оставил нужную ветвь.", references: [], suggestionIds: [], uiActions: [{ type: "filter_people", personIds: ["e2e-memorial-person", "e2e-child", "e2e-grandchild"], label: "Выбранная ветвь" }] })}\n\n`,
    }),
  );
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/, {
    timeout: 5_000,
  });
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  await panel.getByRole("textbox").fill("Убери из древа лишних");
  await panel.getByRole("button", { name: "Отправить запрос" }).click();
  await expect(page.locator(".tree-family-tools")).toContainText(
    "Выбранная ветвь: 3",
  );
  await panel.getByRole("button", { name: "Закрыть ИИ-исследователя" }).click();

  const parent = page.getByTestId("rf__node-e2e-child");
  const descendant = page.getByTestId("rf__node-e2e-grandchild");
  await expect(descendant).toBeVisible();
  await parent.getByRole("button", { name: "Свернуть потомков" }).click();
  await expect(descendant).toHaveCount(0);
  await expect(page.locator(".tree-family-tools")).toContainText(
    "Выбранная ветвь: 2",
  );
  await parent.getByRole("button", { name: "Развернуть потомков" }).click();
  await expect(descendant).toBeVisible();
  await expect(page.locator(".tree-family-tools")).toContainText(
    "Выбранная ветвь: 3",
  );
});

test("manual card selection does not break a later AI navigation", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.route("**/api/ai/status", (route) =>
    route.fulfill({ json: { enabled: true, streaming: true } }),
  );
  await page.route("**/api/ai/chats", (route) =>
    route.fulfill({ json: { chats: [] } }),
  );
  let turn = 0;
  await page.route("**/api/ai/chat/stream", (route) => {
    const personId = ++turn === 1 ? "e2e-memorial-person" : "e2e-grandchild";
    return route.fulfill({
      contentType: "text/event-stream; charset=utf-8",
      body: `event: done\ndata: ${JSON.stringify({ answer: "Показываю.", references: [], suggestionIds: [], uiActions: [{ type: "focus_people", personIds: [personId] }] })}\n\n`,
    });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow/, {
    timeout: 5_000,
  });
  await page.getByRole("button", { name: "Открыть ИИ-исследователя" }).click();
  const panel = page.locator(".research-assistant");
  const ask = async () => {
    await panel.getByRole("textbox").fill("Покажи человека");
    await panel.getByRole("button", { name: "Отправить запрос" }).click();
  };
  await ask();
  await expect(page.getByTestId("rf__node-e2e-memorial-person")).toHaveClass(
    /selected/,
  );
  const viewport = page.locator(".react-flow__viewport");
  await page
    .getByTestId("rf__node-e2e-spouse")
    .locator(".flow-person-content")
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByTestId("rf__node-e2e-spouse")).toHaveClass(/selected/);
  const afterManualClick = await viewport.getAttribute("style");
  await page.waitForTimeout(750);
  expect(await viewport.getAttribute("style")).toBe(afterManualClick);
  await ask();
  const target = page.getByTestId("rf__node-e2e-grandchild");
  await expect(target).toHaveClass(/selected/);
  await expect
    .poll(async () => {
      const [card, canvas] = await Promise.all([
        target.boundingBox(),
        page.locator(".tree-canvas").boundingBox(),
      ]);
      return card && canvas
        ? Math.abs(card.x + card.width / 2 - (canvas.x + canvas.width / 2))
        : Infinity;
    })
    .toBeLessThan(20);
});

test("reduced motion skips the tree and fan transitions", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-grow/, { timeout: 3_000 });
  await expect(page.getByTestId("rf__node-e2e-child")).toHaveCSS(
    "animation-name",
    "none",
  );
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.getByRole("button", { name: "Семья выбранного" }).click();
  const selectedCard = page.getByTestId("rf__node-e2e-child");
  await expect(selectedCard).toHaveCSS("animation-name", "none");
  await expect(selectedCard).toHaveCSS("transition-duration", "0s");
  await page.getByRole("button", { name: "Всё древо" }).click();
  await page.getByRole("button", { name: "Веер", exact: true }).click();
  await expect(canvas).toHaveClass(/(?:^|\s)is-fan(?:\s|$)/);
  await expect(canvas).not.toHaveClass(/is-fan-revealing/);
});
