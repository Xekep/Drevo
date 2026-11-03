import { expect, test, type Page } from "@playwright/test";
import { applyArchiveChanges, type Change } from "../../src/domain/changes.ts";
import type { Family } from "../../src/domain/types.ts";
import {
  biographyMapBlock,
  type BiographyMap,
} from "../../src/domain/biography-map.ts";

const routeMap: BiographyMap = {
  type: "FeatureCollection",
  name: "Боевой путь",
  features: [
    {
      type: "Feature",
      properties: { name: "Первый пункт", date: "1942" },
      geometry: { type: "Point", coordinates: [30, 50] },
    },
    {
      type: "Feature",
      properties: { name: "Второй пункт", date: "1943" },
      geometry: { type: "Point", coordinates: [32, 52] },
    },
    {
      type: "Feature",
      properties: { name: "Маршрут" },
      geometry: {
        type: "LineString",
        coordinates: [
          [30, 50],
          [32, 52],
        ],
      },
    },
  ],
};
async function setup(page: Page, biography: string) {
  await page.route("https://tile.openstreetmap.org/**", (route) =>
    route.fulfill({ status: 204, body: "" }),
  );
  const response = await page.request.get("/api/family?projection=overview"),
    initial = await response.json();
  let family = (await (await page.request.get("/api/family")).json())
      .family as Family,
    revision = initial.revision;
  family.people.find((p) => p.id === "e2e-child")!.biography = biography;
  await page.route("**/api/family?projection=overview", (route) =>
    route.fulfill({
      response,
      json: { ...initial, family, revision, partial: false },
    }),
  );
  await page.route("**/api/family/changes", (route) => {
    const changes = route.request().postDataJSON().changes as Change[],
      applied = applyArchiveChanges(family, changes);
    expect(applied.conflicts).toEqual([]);
    family = applied.family;
    revision++;
    return route.fulfill({
      json: { family, revision, appliedChanges: changes },
    });
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/tree");
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  return () => family.people.find((p) => p.id === "e2e-child")!.biography || "";
}
async function edit(page: Page) {
  await page.locator(".inspector-person-actions .person-edit-button").click();
  await page.getByText("Жизнь и занятия", { exact: true }).click();
  await expect(page.locator(".biography-editor .cm-content")).toBeVisible();
  return page.locator(".biography-editor");
}

test("typing in global search preserves the mounted biography mini-map and markers", async ({ page }) => {
  await setup(page, biographyMapBlock(routeMap));
  const mini = page.locator(".inspector-dock .biography-map-mini");
  await mini.scrollIntoViewIfNeeded();
  await expect(mini.locator(".leaflet-marker-icon")).toHaveCount(2);
  const original = await mini.elementHandle();
  const marker = await mini.locator(".leaflet-marker-icon").first().elementHandle();
  const search = page.getByRole("combobox", { name: "Найти человека или документ", exact: true });
  for (const value of ["т", "те", "тес", "тест"]) {
    await search.fill(value);
    await expect(search).toHaveValue(value);
    expect(await mini.evaluate((node, old) => node === old, original)).toBe(true);
    expect(await mini.locator(".leaflet-marker-icon").first().evaluate((node, old) => node === old, marker)).toBe(true);
  }
  await search.fill("");
  await mini.click();
  await expect(page.getByRole("region", { name: "Карта из биографии" })).toBeVisible();
});

test("route list focuses the matching native marker and leaves unknown places as text", async ({ page }) => {
  const data: BiographyMap = { ...routeMap, features: [
    routeMap.features[2],
    { type: "Feature", geometry: null, properties: { name: "Место неизвестно" } },
    ...routeMap.features.slice(0, 2),
  ] };
  await setup(page, biographyMapBlock(data));
  await page.locator(".inspector-dock .biography-map-mini").click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  const summary = workspace.getByText("Точки маршрута", { exact: true });
  const popup = workspace.locator(".leaflet-popup");
  await summary.click();
  await expect(workspace.getByRole("button", { name: "Место неизвестно" })).toBeDisabled();
  await workspace.getByRole("button", { name: "Второй пункт 1943" }).click();
  await expect(popup).toContainText("Второй пункт");
  const selected = workspace.locator('.leaflet-marker-icon[alt="Второй пункт"]');
  await expect(selected).toBeFocused();
  await expect(selected).toBeInViewport();
  await summary.click();
  await workspace.getByRole("button", { name: "Первый пункт 1942" }).focus();
  await page.keyboard.press("Enter");
  await expect(popup).toContainText("Первый пункт");
  await expect(workspace.locator('.leaflet-marker-icon[alt="Первый пункт"]')).toBeInViewport();
  // Selecting the same point again must still reopen its popup.
  await workspace.locator(".leaflet-popup-close-button").click();
  await summary.click();
  await workspace.getByRole("button", { name: "Первый пункт 1942" }).click();
  await expect(popup).toContainText("Первый пункт");
});

test("native route lines remain painted in newly exposed areas before mouse release", async ({ page }) => {
  await setup(page, biographyMapBlock({ type: "FeatureCollection", features: [{
    type: "Feature", properties: { name: "Длинный маршрут" },
    geometry: { type: "LineString", coordinates: [[-20, 50], [80, 50]] },
  }] }));
  await page.locator(".inspector-dock .biography-map-mini").click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  const surface = workspace.locator(".biography-map-surface");
  const line = surface.locator("path.leaflet-interactive");
  for (let i = 0; i < 4; i++) await workspace.getByRole("button", { name: "Увеличить масштаб", exact: true }).click();
  const box = (await surface.boundingBox())!;
  const lineY = await line.evaluate(node => {
    const path = node as SVGPathElement;
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    return new DOMPoint(point.x, point.y).matrixTransform(path.getScreenCTM()!).y;
  });
  const pane = surface.locator(".leaflet-map-pane");
  const initial = await pane.getAttribute("style");
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.75);
  await page.mouse.down();
  try {
    await page.mouse.move(box.x + box.width * 0.85, box.y + box.height * 0.75, { steps: 12 });
    await expect(pane).not.toHaveAttribute("style", initial!);
    // Hit testing uses the actual painted stroke, including SVG clipping. The
    // sampled segment was outside the renderer's old clipping rectangle.
    await expect.poll(() => line.evaluate((node, point) =>
      document.elementFromPoint(point.x, point.y) === node,
      { x: box.x + box.width * 0.15, y: lineY })).toBe(true);
    await page.screenshot({ path: test.info().outputPath("route-during-drag.png") });
  } finally { await page.mouse.up(); }
});

test("mobile map gives room to the canvas and dismisses the route list on map taps", async ({ page }, info) => {
  await setup(page, biographyMapBlock(routeMap));
  await page.locator(".inspector-dock .biography-map-mini").click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  const dock = page.locator(".inspector-dock");
  const points = workspace.locator(".biography-map-points-list");
  const surface = workspace.locator(".biography-map-surface");
  const mobile = info.project.name === "mobile";
  if (mobile) {
    await expect(dock).toHaveClass(/is-map-peek/);
    expect((await dock.boundingBox())!.height).toBeLessThan(75);
    await expect(dock.getByRole("tab", { name: "О человеке", exact: true })).toBeHidden();
    await expect(workspace.locator("header h2")).toBeHidden();
    await expect(workspace.locator(".biography-map-close > span")).toBeHidden();
    await expect(workspace.locator(".biography-map-close > svg")).toBeVisible();
  } else {
    await expect(workspace.locator("header h2")).toBeVisible();
    await expect(dock).not.toHaveClass(/is-map-peek/);
  }
  await points.locator("summary").click();
  const bounds = (await surface.boundingBox())!;
  await surface.click({ position: { x: 15, y: bounds.height - 65 } });
  if (mobile) {
    await expect(points).not.toHaveAttribute("open", "");
    await points.locator("summary").click();
    await workspace.locator(".leaflet-marker-icon").first().click();
    await expect(points).not.toHaveAttribute("open", "");
    await expect(workspace.locator(".leaflet-popup")).toContainText("Первый пункт");
    await dock.getByRole("button", { name: "Развернуть панель", exact: true }).click();
    await expect(dock.getByRole("tab", { name: "О человеке", exact: true })).toBeVisible();
    await dock.getByRole("button", { name: "Свернуть панель", exact: true }).click();
    await expect(dock).toHaveClass(/is-map-peek/);
    await page.screenshot({ path: info.outputPath("mobile-map-compact.png") });
  } else await expect(points).toHaveAttribute("open", "");
  await workspace.getByRole("button", { name: "Вернуться к древу", exact: true }).click();
  await expect(workspace).toHaveCount(0);
  await expect(dock).not.toHaveClass(/is-map-peek/);
  if (mobile) await expect(dock).toHaveClass(/expanded/);
});

test("map hides the AI launcher and a mobile person card places it on the right", async ({ page }, info) => {
  await page.route("**/api/ai/status", route => route.fulfill({ json: { enabled: true, streaming: true } }));
  await setup(page, biographyMapBlock(routeMap));
  const launcher = page.getByRole("button", { name: "Открыть ИИ-исследователя", exact: true });
  await expect(launcher).toBeVisible();
  if (info.project.name === "mobile") {
    await expect.poll(async () => {
      const box = (await launcher.boundingBox())!;
      return Math.abs(page.viewportSize()!.width - box.x - box.width - 18);
    }).toBeLessThan(2);
  }
  await page.locator(".inspector-dock .biography-map-mini").click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  await expect(workspace).toBeVisible();
  await expect(launcher).toHaveCount(0);
  await workspace.getByRole("button", { name: "Вернуться к древу", exact: true }).click();
  await expect(launcher).toBeVisible();
});

test("biography exposes Markdown only on the active line and preserves source on save", async ({
  page,
}) => {
  const source =
    "# Заголовок\nПервая **жирная** строка\nВторая *курсивная* строка\n\n- Пункт";
  const read = await setup(page, source),
    editor = await edit(page);
  const first = editor.locator(".cm-line").filter({ hasText: "Первая" }),
    second = editor.locator(".cm-line").filter({ hasText: "Вторая" });
  await expect(first).toHaveText("Первая жирная строка");
  await first.click();
  await expect(first).toHaveText("Первая **жирная** строка");
  await second.click();
  await expect(first).toHaveText("Первая жирная строка");
  await expect(second).toHaveText("Вторая *курсивная* строка");
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe(source);
});

test("a map replaces the tree, lists dated points and restores the same camera", async ({
  page,
}) => {
  await setup(page, "История пути\n\n" + biographyMapBlock(routeMap));
  const mini = page.locator(".inspector-dock .biography-map-mini");
  await expect(mini).toBeVisible();
  const transform = await page
    .locator(".react-flow__viewport")
    .getAttribute("style");
  await mini.click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  await expect(workspace).toBeVisible();
  await expect(page.locator(".tree-scene")).toHaveAttribute("inert", "");
  await expect(page.locator(".tree-view")).not.toHaveAttribute("inert", "");
  const inspector = page.locator(".inspector-dock");
  await expect(inspector).toBeVisible();
  await expect(inspector.locator(".person-edit-button")).toBeEnabled();
  const mapBounds = await workspace.boundingBox(),
    inspectorBounds = await inspector.boundingBox();
  if (test.info().project.name === "desktop")
    expect(mapBounds!.x + mapBounds!.width).toBeLessThanOrEqual(
      inspectorBounds!.x + 1,
    );
  else
    expect(mapBounds!.y + mapBounds!.height).toBeLessThanOrEqual(
      inspectorBounds!.y + 1,
    );
  await workspace.getByText("Точки маршрута", { exact: true }).click();
  await expect(workspace).toContainText("Первый пункт");
  await expect(workspace).toContainText("1943");
  await expect(workspace.locator(".leaflet-marker-icon")).toHaveCount(2);
  await expect(workspace.locator("path.leaflet-interactive")).toHaveCount(1);
  if (test.info().project.name === "mobile")
    await inspector.getByRole("button", { name: "Развернуть панель", exact: true }).click();
  await inspector.getByRole("tab", { name: /Обсуждение/ }).click();
  await expect(workspace).toBeVisible();
  await inspector
    .getByRole("tab", { name: "О человеке", exact: true })
    .click();
  await page.screenshot({ path: test.info().outputPath("map-workspace.png") });
  await page.keyboard.press("Escape");
  await expect(workspace).toHaveCount(0);
  await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
    "style",
    transform!,
  );
  await expect(mini).toBeVisible();
});

test("a map and the same person inspector remain available inside mobile fullscreen", async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== "mobile",
    "The flat-tree fullscreen control is mobile-only",
  );
  await setup(page, biographyMapBlock(routeMap));
  await page
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Развернуть на весь экран", exact: true })
    .click();
  await expect(page.locator(".tree-canvas")).toHaveClass(/is-fullscreen/);
  await page
    .getByTestId("rf__node-e2e-child")
    .locator(".flow-person-content")
    .click();
  await page.locator(".inspector-dock .biography-map-mini").click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  await expect(workspace).toBeVisible();
  await expect(page.locator(".inspector-dock")).toBeVisible();
  await expect(workspace.locator(".leaflet-marker-icon")).toHaveCount(2);
  await workspace.getByRole("button", { name: "Вернуться к древу" }).click();
  await expect(workspace).toHaveCount(0);
  await expect(page.locator(".tree-scene")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".tree-canvas")).toBeVisible();
});

test("native markers stay anchored during zoom and long captions wrap in Leaflet tooltips", async ({
  page,
}, info) => {
  const map = structuredClone(routeMap);
  const title =
    "Длинное название исторического места на границе нескольких областей";
  const description =
    "Подробное описание события и документальных свидетельств. ".repeat(60);
  map.features[0].properties = { name: title, date: "1943-05-10", description };
  await setup(page, biographyMapBlock(map));
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.locator(".inspector-dock .biography-map-mini").click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  const marker = workspace.locator(".leaflet-marker-icon").first();
  await expect(marker).toBeVisible();
  expect(
    await marker.evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ).toBeGreaterThan(0);
  await marker.hover();
  const tooltip = workspace.locator(".leaflet-tooltip");
  await expect(tooltip).toContainText(title);
  await expect(tooltip).toContainText("1943-05-10");
  await expect(tooltip).not.toContainText("Подробное описание");
  const bounds = await tooltip.boundingBox();
  expect(bounds!.width).toBeGreaterThan(160);
  expect(bounds!.width).toBeLessThanOrEqual(281);
  expect(bounds!.height).toBeLessThan(140);
  await marker.click();
  const popup = workspace.locator(".leaflet-popup-content");
  await expect(popup).toContainText(description.trim());
  expect((await popup.boundingBox())!.height).toBeLessThanOrEqual(241);
  await workspace.locator(".leaflet-popup-close-button").click();
  // Compare the marker tip with the same geographic coordinate projected
  // through a real tile element, throughout the native zoom transition.
  const samples = await workspace.evaluate(async (root) => {
    const frames: { error: number; width: number; x: number }[] = [];
    const start = performance.now();
    (root.querySelector(".leaflet-control-zoom-in") as HTMLElement).click();
    while (performance.now() - start < 450) {
      await new Promise(requestAnimationFrame);
      const marker = root
        .querySelector(".leaflet-marker-icon")!
        .getBoundingClientRect();
      const tile = root.querySelector("img.leaflet-tile") as HTMLImageElement;
      const match = new URL(tile.src).pathname.match(
        /\/(\d+)\/(\d+)\/(\d+)\.png$/,
      )!;
      const [z, tx, ty] = match.slice(1).map(Number),
        box = tile.getBoundingClientRect();
      const world = 2 ** z,
        lat = (50 * Math.PI) / 180;
      const x = box.left + (((30 + 180) / 360) * world - tx) * box.width;
      const y =
        box.top +
        (((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) *
          world -
          ty) *
          box.height;
      frames.push({
        error: Math.hypot(marker.left + 12 - x, marker.bottom - y),
        width: marker.width,
        x: marker.left,
      });
    }
    return frames;
  });
  expect(samples.length).toBeGreaterThan(3);
  expect(Math.max(...samples.map((s) => s.error))).toBeLessThan(4);
  expect(samples.every((s) => Math.abs(s.width - 25) < 0.1)).toBe(true);
  expect(Math.abs(samples.at(-1)!.x - samples[0].x)).toBeGreaterThan(5);
  await info.attach("marker-zoom", {
    body: JSON.stringify(samples),
    contentType: "application/json",
  });
});

async function pasteMap(content: ReturnType<Page["locator"]>, source: string) {
  await content.evaluate((node, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", text);
    node.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, source);
}

test("raw GeoJSON paste folds to an icon, source editing preserves metadata and saves a mini-map", async ({
  page,
}, info) => {
  const read = await setup(page, "Воспоминания"),
    editor = await edit(page);
  await expect(
    editor.getByRole("button", { name: "Добавить карту" }),
  ).toHaveCount(0);
  const imported = structuredClone(routeMap);
  imported.features[0].id = "imported-1";
  imported.features[0].properties = {
    name: "<img src=x onerror=alert(1)>",
    source: { page: 5 },
    unit: "Полк",
  };
  const raw = JSON.stringify(imported, null, 2),
    content = editor.locator(".cm-content");
  await content.click();
  await content.press("Control+End");
  await pasteMap(content, raw);
  const icon = editor.getByRole("button", {
    name: "Показать GeoJSON: Боевой путь",
  });
  await expect(icon).toBeVisible();
  await expect(
    editor.locator(".biography-map-mini, .leaflet-container"),
  ).toHaveCount(0);
  await content.press("Control+z");
  await expect(icon).toHaveCount(0);
  await content.press("Control+y");
  await expect(icon).toBeVisible();
  await icon.click();
  await expect(content).toContainText('"FeatureCollection"');
  await expect(icon).toHaveCount(0);
  await editor.locator(".cm-line").filter({ hasText: "Воспоминания" }).click();
  await expect(icon).toBeVisible();
  await page.screenshot({ path: info.outputPath("geojson-source-icon.png") });
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe("Воспоминания\n\n```geojson\n" + raw + "\n```\n\n");
  const mini = page.locator(".inspector-dock .biography-map-mini");
  await expect(mini).toBeVisible();
  await mini.click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  await workspace.getByText("Точки маршрута", { exact: true }).click();
  await expect(workspace).toContainText("<img src=x onerror=alert(1)>");
  await expect(workspace.locator("img[onerror]")).toHaveCount(0);
});

test("repeated map icons reveal the selected block and keyboard editing changes only that map", async ({
  page,
}) => {
  const block = biographyMapBlock(routeMap),
    read = await setup(page, block + "\n\nМежду картами\n\n" + block);
  const editor = await edit(page),
    icons = editor.getByRole("button", {
      name: "Показать GeoJSON: Боевой путь",
    });
  await expect(icons).toHaveCount(2);
  await icons.nth(1).focus();
  await icons.nth(1).press("Enter");
  const name = editor
    .locator(".cm-line")
    .filter({ hasText: '"name": "Боевой путь"' });
  await expect(name).toHaveCount(1);
  await name.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  await page.keyboard.insertText('"name": "Вторая карта",');
  await editor.locator(".cm-line").filter({ hasText: "Между картами" }).click();
  await expect(
    editor.getByRole("button", { name: "Показать GeoJSON: Вторая карта" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe(
    block +
      "\n\nМежду картами\n\n" +
      block.replace("Боевой путь", "Вторая карта"),
  );
});

test("malformed GeoJSON stays editable and fixing it folds it without losing source", async ({
  page,
}) => {
  const source = "До карты\n\n```geojson\n{broken}\n```\n\nПосле карты";
  const read = await setup(page, source),
    editor = await edit(page),
    content = editor.locator(".cm-content");
  await expect(editor.locator(".biography-map-source")).toHaveCount(0);
  const broken = editor.locator(".cm-line").filter({ hasText: "{broken}" });
  await broken.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");
  const raw = JSON.stringify({ type: "Point", coordinates: [30, 50] });
  await pasteMap(content, raw); // Inside the existing fence: do not add a second fence.
  await editor.locator(".cm-line").filter({ hasText: "После карты" }).click();
  await expect(
    editor.getByRole("button", { name: "Показать GeoJSON: Карта жизни" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe(source.replace("{broken}", raw));
});

test("expanded life editor cancels and applies GeoJSON source drafts explicitly", async ({
  page,
}) => {
  const source = "Исходная **биография**",
    read = await setup(page, source);
  await edit(page);
  const expand = page.getByRole("button", {
    name: "Открыть жизнь и занятия в отдельном окне",
  });
  await expand.click();
  const life = page.getByRole("dialog", {
    name: "Жизнь и занятия",
    exact: true,
  });
  const text = life.locator(".cm-content");
  await text.click();
  await text.press("Control+End");
  await pasteMap(text, JSON.stringify(routeMap));
  await expect(life.locator(".biography-map-source")).toBeVisible();
  page.once("dialog", (d) => d.accept());
  await life.getByRole("button", { name: "Отмена", exact: true }).click();
  await expect(life).toHaveCount(0);
  await expect(
    page.locator(".biography-editor .biography-map-source"),
  ).toHaveCount(0);
  await expand.click();
  await text.click();
  await text.press("Control+End");
  await text.press("End");
  await text.pressSequentially(" дополнено");
  await life.getByRole("button", { name: "Готово", exact: true }).click();
  expect(read()).toBe(source);
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe(source + " дополнено");
});

test("large GeoJSON with unlocated records folds promptly, stays responsive and opens a map", async ({
  page,
}, info) => {
  const imported = {
    type: "FeatureCollection",
    name: "Большой исторический маршрут",
    metadata: { note: "Исходные сведения сохраняются целиком" },
    features: Array.from({ length: 97 }, (_, i) => ({
      type: "Feature",
      id: `record-${i}`,
      properties: {
        name: `Пункт ${i}`,
        date: "1942",
        description: "Описание события и основания привязки. ".repeat(10),
        source_urls: ["https://example.org/archive/document?reference=12345"],
      },
      geometry:
        i < 19
          ? null
          : { type: "Point", coordinates: [30 + i / 10, 50 + i / 20] },
    })),
  };
  const raw = JSON.stringify(imported, null, 2);
  expect(raw.length).toBeGreaterThan(60_000);
  expect(raw.length).toBeLessThan(100_000);
  const read = await setup(page, "До карты"),
    editor = await edit(page),
    content = editor.locator(".cm-content");
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await content.click();
  await content.press("Control+End");
  const pasteStart = Date.now();
  await pasteMap(content, raw);
  const icon = editor.getByRole("button", {
    name: "Показать GeoJSON: Большой исторический маршрут",
  });
  await expect(icon).toBeVisible({ timeout: 3000 });
  const pasteMs = Date.now() - pasteStart;
  await expect(editor.locator(".leaflet-container")).toHaveCount(0);
  await icon.click();
  await expect(icon).toHaveCount(0);
  // Moving within the expanded source must not reparse the entire Markdown
  // and GeoJSON document for every selection update.
  const cursorStart = Date.now();
  for (let i = 0; i < 30; i++) await page.keyboard.press("ArrowDown");
  const cursorMs = Date.now() - cursorStart;
  expect(cursorMs).toBeLessThan(3000);
  await content.press("Control+End");
  await expect(icon).toBeVisible();
  await page.getByRole("button", { name: "Сохранить", exact: true }).click();
  expect(read()).toBe("До карты\n\n```geojson\n" + raw + "\n```\n\n");
  await page.locator(".inspector-dock .biography-map-mini").click();
  const workspace = page.getByRole("region", { name: "Карта из биографии" });
  await expect(workspace.locator(".leaflet-marker-icon")).toHaveCount(78);
  await workspace.getByText("Точки маршрута", { exact: true }).click();
  await expect(
    workspace.getByText("Место не привязано к карте", { exact: true }),
  ).toHaveCount(19);
  expect(errors).toEqual([]);
  await info.attach("geojson-timing", {
    body: JSON.stringify({ characters: raw.length, pasteMs, cursorMs }),
    contentType: "application/json",
  });
});
