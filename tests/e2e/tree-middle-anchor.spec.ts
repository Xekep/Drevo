import { expect, test } from "@playwright/test";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences";

test("middle click preserves generation depths, while middle drag only pans", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Shortcut for a mouse with a wheel");
  await page.emulateMedia({ reducedMotion: "reduce" });
  let preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
    generationLimits: {
      anchorId: "e2e-child",
      ancestors: 7,
      descendants: 50,
      collateral: 2,
    },
  };
  let writes = 0;
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), treePreferences: preferences },
    });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    if (route.request().method() === "PUT") {
      preferences = route.request().postDataJSON();
      writes++;
    }
    await route.fulfill({ json: preferences });
  });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  const card = page
    .locator('.flow-person[data-person-id="e2e-sibling"] .flow-person-content')
    .first();
  await expect(card).toBeVisible();
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  // Move away and back: release distance alone must not turn a drag into a click.
  const box = (await card.boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + 40, y + 25, { steps: 5 });
  await expect(viewport).not.toHaveAttribute("style", before!);
  await page.mouse.move(x, y, { steps: 5 });
  await page.mouse.up({ button: "middle" });
  expect(writes).toBe(0);
  expect(preferences.generationLimits?.anchorId).toBe("e2e-child");
  await card.click({ button: "middle" });
  await expect
    .poll(() => preferences.generationLimits?.anchorId)
    .toBe("e2e-sibling");
  expect(preferences.generationLimits).toEqual({
    anchorId: "e2e-sibling",
    ancestors: 7,
    descendants: 50,
    collateral: 2,
  });
  await expect(
    canvas
      .getByRole("status", { name: "" })
      .filter({ hasText: "Опорный человек:" }),
  ).toBeVisible();
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
  await page.reload();
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await expect(
    page.getByRole("combobox", { name: "Относительно человека" }),
  ).toHaveValue("Тестова Мария Ивановна");
});

for (const firstOperation of ["reset", "anchor"] as const) {
  test(`serialize generation ${firstOperation} with a pending preference write`, async ({ page, isMobile }) => {
    test.skip(isMobile, "Shortcut for a mouse with a wheel");
    await page.emulateMedia({ reducedMotion: "reduce" });
    let preferences: TreePreferences = {
      ...DEFAULT_TREE_PREFERENCES,
      generationLimits: { anchorId: "e2e-child", ancestors: 3, descendants: 1, collateral: 0 },
    };
    const writes: TreePreferences[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/family?projection=overview", async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...(await response.json()), treePreferences: preferences } });
    });
    await page.route("**/api/tree-preferences", async (route) => {
      if (route.request().method() === "PUT") {
        const value = route.request().postDataJSON() as TreePreferences;
        writes.push(value);
        if (writes.length === 1) await pending;
        preferences = value;
      }
      await route.fulfill({ json: preferences });
    });
    await page.goto("/tree");
    const canvas = page.locator(".tree-canvas");
    const anchor = canvas.getByRole("status", { name: "Опорный человек" });
    const reset = anchor.getByRole("button", { name: "Всё древо", exact: true });
    const parent = page.locator('.flow-person[data-person-id="e2e-memorial-person"] .flow-person-content').first();
    await expect(canvas).toHaveAttribute("data-layout-people", "4");
    await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
    try {
      if (firstOperation === "reset") await reset.click();
      else await parent.click({ button: "middle" });
      await expect.poll(() => writes.length).toBe(1);
      await expect(anchor).toHaveAttribute("aria-busy", "true");
      await expect(reset).toBeDisabled();
      await expect(canvas.locator(".tree-notice")).toHaveText("Сохраняем вид древа…");
      if (firstOperation === "reset") {
        // The card gesture remains available for panning, but its anchor write
        // must not race the held reset or revive the previous generation range.
        await parent.click({ button: "middle" });
      } else {
        // Native disabled controls ignore activation while the anchor is saving.
        await reset.evaluate((element: HTMLButtonElement) => element.click());
      }
      expect(writes).toHaveLength(1);
      expect(preferences.generationLimits?.anchorId).toBe("e2e-child");
    } finally {
      release();
    }
    await expect(canvas.locator(".tree-notice")).not.toHaveText("Сохраняем вид древа…");
    if (firstOperation === "anchor") {
      await expect(anchor).toContainText("Опорный: Тестов Иван Петрович");
      expect(preferences.generationLimits?.anchorId).toBe("e2e-memorial-person");
      await expect(reset).toBeEnabled();
      await reset.click();
    }
    await expect(anchor).toHaveCount(0);
    await expect(canvas).toHaveAttribute("data-layout-people", "6");
    await expect(page.locator('.flow-person[data-person-id="e2e-sibling-child"]')).toBeVisible();
    expect(preferences.generationLimits).toBeNull();
    expect(writes).toHaveLength(firstOperation === "reset" ? 1 : 2);
  });
}

for (const mode of ["shared", "public"] as const) {
  test(`middle click enables defaults locally on a ${mode} tree`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "Shortcut for a mouse with a wheel");
    await page.emulateMedia({ reducedMotion: "reduce" });
    const archive = await (await page.request.get("/api/family")).json();
    const token = "s".repeat(43);
    const writes: string[] = [];
    page.on("request", (request) => {
      if (
        request.url().includes("/api/") &&
        !["GET", "HEAD"].includes(request.method())
      )
        writes.push(request.url());
    });
    if (mode === "shared") {
      await page.route(`**/api/shared/${token}`, (route) =>
        route.fulfill({
          json: {
            family: archive.family,
            serverTime: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        }),
      );
    } else {
      await page.route("**/api/family?projection=overview", (route) =>
        route.fulfill({
          json: {
            ...archive,
            user: null,
            canEdit: false,
            readTree: true,
            partial: false,
            treePreferences: null,
          },
        }),
      );
    }
    await page.goto(mode === "shared" ? `/s/${token}` : "/tree");
    const card = page
      .locator('.flow-person[data-person-id="e2e-child"] .flow-person-content')
      .first();
    await expect(card).toBeVisible();
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-growing|is-layout-settling/,
    );
    await card.click({ button: "middle" });
    await expect(page.locator(".tree-notice")).toContainText(
      "Опорный человек:",
    );
    await page.reload();
    await page.getByRole("button", { name: "Настройки древа" }).click();
    const dialog = page.getByRole("dialog", { name: "Вид древа" });
    await expect(
      dialog.getByRole("combobox", { name: "Относительно человека" }),
    ).toHaveValue("Тестов Пётр Иванович");
    await expect(
      dialog.getByRole("radio", { name: "Вверх: 3", exact: true }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("radio", { name: "Вниз: 3", exact: true }),
    ).toBeChecked();
    await expect(
      dialog.getByRole("radio", { name: "Боковые ветви: 1", exact: true }),
    ).toBeChecked();
    expect(writes).toEqual([]);
  });
}

test("middle click hits a person in the Canvas fallback overview of a 600-person tree", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Shortcut for a mouse with a wheel");
  test.setTimeout(90_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  let preferences: TreePreferences = { ...DEFAULT_TREE_PREFERENCES };
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const archive = await response.json();
    const seed = archive.family.people[0];
    archive.family.people = Array.from({ length: 600 }, (_, i) => ({
      ...seed,
      id: `middle-${i}`,
      name: `Человек ${i}`,
      birth: `${1700 + (i % 12) * 24}-01-01`,
      parents: i % 12 ? [`middle-${i - 1}`] : [],
      spouses: [],
      photo: undefined,
    }));
    archive.family.links = [];
    archive.family.unions = [];
    archive.partial = false;
    archive.user.personId = null;
    archive.treePreferences = preferences;
    await route.fulfill({ response, json: archive });
  });
  await page.route("**/api/tree-preferences", async (route) => {
    preferences = route.request().postDataJSON();
    await route.fulfill({ json: preferences });
  });
  await page.addInitScript(() => {
    // This case exercises the production Canvas fallback specifically. A
    // capable GPU otherwise replaces the overview before its locator is read.
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args
    ) {
      if (args[0] === "webgl2") return null;
      return Reflect.apply(getContext, this, args);
    } as typeof getContext;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent) => {
          if (event.data?.geometry?.occurrences?.length >= 600)
            Object.assign(window, { __middleGeometry: event.data.geometry });
        });
      }
    };
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-distant-portraits")).toHaveAttribute(
    "data-scene-nodes",
    "600",
    { timeout: 60_000 },
  );
  await expect(page.locator(".tree-canvas")).not.toHaveClass(
    /is-growing|is-layout-settling/,
  );
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-gpu-fallback",
    "WebGL2 unavailable",
  );
  await expect(page.locator(".tree-distant-portraits")).toBeVisible();
  const point = await page.evaluate(() => {
    const geometry = (
      window as typeof window & {
        __middleGeometry: {
          positions: [string, { x: number; y: number }][];
          occurrences: { id: string; personId: string }[];
          nodeSize: { width: number; height: number };
        };
      }
    ).__middleGeometry;
    const root = document
      .querySelector(".tree-canvas")!
      .getBoundingClientRect();
    const bounds = document
      .querySelector(".react-flow")!
      .getBoundingClientRect();
    const clip = {
      left: Math.max(0, root.left, bounds.left),
      right: Math.min(innerWidth, root.right, bounds.right),
      top: Math.max(0, root.top, bounds.top),
      bottom: Math.min(innerHeight, root.bottom, bounds.bottom),
    };
    const matrix = new DOMMatrix(
      getComputedStyle(document.querySelector(".react-flow__viewport")!)
        .transform,
    );
    const people = new Map(
      geometry.occurrences.map((node) => [node.id, node.personId]),
    );
    for (const [id, pos] of geometry.positions) {
      const x =
        bounds.x + matrix.e + (pos.x + geometry.nodeSize.width / 2) * matrix.a;
      const y = bounds.y + matrix.f + (pos.y + 70) * matrix.a;
      if (
        x < clip.left + 8 ||
        x > clip.right - 8 ||
        y < clip.top + 8 ||
        y > clip.bottom - 8
      )
        continue;
      const personId = people.get(id);
      const target = document.elementFromPoint(x, y);
      if (
        personId &&
        target?.closest(".react-flow__pane") &&
        !target.closest("button, a, input, select, textarea")
      )
        return { x, y, id: personId };
    }
    return null;
  });
  expect(point).not.toBeNull();
  await page.mouse.click(point!.x, point!.y, { button: "middle" });
  await expect
    .poll(() => preferences.generationLimits?.anchorId)
    .toBe(point!.id);
  await expect(page.locator(".tree-notice")).toContainText("Опорный человек:");
  await expect(
    page.locator(`.flow-person[data-person-id="${point!.id}"]`),
  ).toBeVisible();
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
});
