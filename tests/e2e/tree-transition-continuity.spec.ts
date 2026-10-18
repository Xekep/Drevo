import { familyViewAction, showTree } from "./tree-toolbar-actions";
import { expect, test } from "@playwright/test";
import type { TreeGeometry } from "../../src/domain/tree-layout.ts";

test("family layout keeps the focused card mounted throughout its move", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  // Exercise interpolation with a guaranteed rigid scene translation. The
  // layout solver may legitimately retain this person's exact coordinates.
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (!/layout[.-]worker/.test(String(url))) return;
        this.addEventListener("message", (event: MessageEvent<{ geometry?: TreeGeometry }>) => {
          const g = event.data.geometry;
          if (!g || g.positions.some(([id]) => id === "000-unrelated")) return;
          const points = new Set<{ x: number }>([
            ...g.positions.map(([, p]) => p),
            ...(g.branches || []).flatMap((b) => b.route.points),
            ...(g.routes || []).flatMap(([, route]) => route.points),
            ...(g.blocks || []), ...(g.siblingGroups || []),
          ]);
          points.forEach((p) => { p.x += 240; });
        });
      }
    };
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    // Removing this component requests the filtered scene's translated geometry.
    data.family.people.push({
      ...data.family.people[0],
      id: "000-unrelated",
      parents: [],
      spouses: [],
    });
    data.partial = false;
    data.treePreferences.cardVariant = "classic";
    await route.fulfill({ response, json: data });
  });
  await page.goto("/people/e2e-child");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  await page.waitForTimeout(900);
  const card = page.getByTestId("rf__node-e2e-child");
  const original = await card.evaluateHandle((node) => node);
  const samples = await canvas.evaluateHandle((root) => {
    const state = {
      removed: false,
      transforms: new Set<string>(),
      stop: () => {},
    };
    const node = root.querySelector<HTMLElement>(
      '[data-testid="rf__node-e2e-child"]',
    )!;
    let frame = 0;
    const tick = () => {
      state.removed ||= !node.isConnected;
      state.transforms.add(getComputedStyle(node).transform);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    state.stop = () => cancelAnimationFrame(frame);
    return state;
  });
  await familyViewAction(page, "Близкие");
  await expect(page.getByTestId("rf__node-000-unrelated")).toHaveCount(0);
  await page.waitForTimeout(1200);
  await samples.evaluate((s) => s.stop());
  expect(await original.evaluate((node) => node.isConnected)).toBe(true);
  expect(await samples.evaluate((s) => s.removed)).toBe(false);
  expect(await samples.evaluate((s) => s.transforms.size)).toBeGreaterThan(3);
});

test("cards fly before the fan reveals on every opening", async ({
  page,
}, testInfo) => {
  await page.goto("/people/e2e-child");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-growing/, { timeout: 5_000 });
  await page.waitForTimeout(900);
  const collapse = page
    .locator(".inspector-dock")
    .getByRole("button", { name: "Свернуть панель" });
  if (testInfo.project.name === "mobile") {
    await expect(collapse).toBeVisible();
    await collapse.click();
  }
  for (let opening = 0; opening < 2; opening++) {
    const samples = await canvas.evaluateHandle((root) => {
      const state = {
        intermediate: false,
        hidden: false,
        flights: new Set<string>(),
        flewBeforeReveal: false,
        stop: () => {},
      };
      let frame = 0;
      const tick = () => {
        const sector = root.querySelector('[data-fan-generation="4"]');
        if (sector) {
          const opacity = Number(getComputedStyle(sector).opacity);
          state.hidden ||= opacity === 0;
          state.intermediate ||= opacity > 0 && opacity < 1;
          const ghost = root.querySelector(".fan-morph-card");
          if (ghost && Number(getComputedStyle(ghost).opacity) > 0.1) {
            state.flights.add(getComputedStyle(ghost).transform);
            state.flewBeforeReveal ||= opacity === 0;
          }
        }
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
      state.stop = () => cancelAnimationFrame(frame);
      return state;
    });
    await familyViewAction(page, "Веер");
    await expect
      .poll(() => samples.evaluate((s) => s.hidden && s.intermediate))
      .toBe(true);
    await expect(canvas).not.toHaveClass(/is-fan-revealing/);
    await samples.evaluate((s) => s.stop());
    expect(await samples.evaluate((s) => s.flewBeforeReveal)).toBe(true);
    expect(await samples.evaluate((s) => s.flights.size)).toBeGreaterThan(3);
    await expect(page.locator(".fan-morph-overlay")).toHaveCount(0);
    await showTree(page);
    await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
    await page.waitForTimeout(750);
  }
});

test("leaving during the fan flight removes its copies and cancels the reveal", async ({
  page,
}, testInfo) => {
  await page.goto("/people/e2e-child");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).not.toHaveClass(/is-grow/);
  const collapse = page
    .locator(".inspector-dock")
    .getByRole("button", { name: "Свернуть панель" });
  if (testInfo.project.name === "mobile") {
    await expect(collapse).toBeVisible();
    await collapse.click();
  }
  await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
  await page.waitForTimeout(750);
  await familyViewAction(page, "Веер");
  await expect(page.locator(".fan-morph-card").first()).toBeVisible();
  await showTree(page);
  await expect(page.locator(".fan-morph-overlay")).toHaveCount(0);
  await page.waitForTimeout(1300);
  await expect(page.locator(".fan-chart")).toHaveCount(0);
  await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
});
