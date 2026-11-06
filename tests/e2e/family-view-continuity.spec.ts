import { expect, test, type Page } from "@playwright/test";
import { familyViewAction } from "./tree-toolbar-actions.ts";
import type { Family } from "../../src/domain/types.ts";

async function probe(page: Page, personId: string) {
  return page.locator(".tree-canvas").evaluateHandle((root, id) => {
    const state = { frames: [] as { zoom: number; x: number; y: number }[], entered: false, stop: () => {} };
    let frame = 0;
    const tick = () => {
      const viewport = root.querySelector(".react-flow__viewport")!;
      const card = root.querySelector(`.flow-person[data-person-id="${id}"]`);
      if (card) {
        const matrix = new DOMMatrix(getComputedStyle(viewport).transform), box = card.getBoundingClientRect();
        state.frames.push({ zoom: matrix.a, x: box.x + box.width / 2, y: box.y + box.height / 2 });
      }
      state.entered ||= !!root.querySelector(".tree-enter-node");
      frame = requestAnimationFrame(tick);
    };
    tick();
    state.stop = () => cancelAnimationFrame(frame);
    return state;
  }, personId);
}

test("blood keeps the anchor scale and close-view plus unfolds only one boundary without a camera flight", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/family?projection=overview", async route => {
    const response = await route.fetch(), data = await response.json();
    const family = data.family as Family, sample = family.people[0];
    sample.parents = ["continuity-grandparent"];
    family.people.push(...["grandparent", "great-grandparent", "unrelated"].map((kind, i) => ({
      ...sample, id: `continuity-${kind}`, name: kind, birth: String(1910 - i * 30), death: undefined,
      parents: kind === "grandparent" ? ["continuity-great-grandparent"] : [], spouses: [], awards: [], sources: [],
    })));
    data.partial = false;
    data.treePreferences = { ...data.treePreferences, animateOnLoad: false, fragmentThreshold: 0, generationLimits: undefined };
    await route.fulfill({ response, json: data });
  });
  await page.goto("/people/e2e-child");
  const root = page.locator(".tree-canvas");
  await expect(root).toHaveAttribute("data-layout-people", "9");
  await expect(root).not.toHaveClass(/is-grow|is-layout-settling/);
  const collapse = page.getByRole("button", { name: "Свернуть панель", exact: true });
  if (await collapse.isVisible()) await collapse.click();
  await page.waitForTimeout(750);
  const area = (await root.boundingBox())!;
  await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -220);
  await page.keyboard.up("Control");
  await page.waitForTimeout(350);
  for (const view of ["Кровные", "Близкие"]) {
    const samples = await probe(page, "e2e-child");
    await familyViewAction(page, view);
    await expect(root).toHaveAttribute("data-layout-ready", "true");
    await page.waitForTimeout(700);
    await samples.evaluate(s => s.stop());
    const frames = await samples.evaluate(s => s.frames), first = frames[0];
    expect(frames.length).toBeGreaterThan(3);
    expect(Math.max(...frames.map(f => Math.abs(f.zoom - first.zoom)))).toBeLessThan(0.00001);
    expect(Math.max(...frames.map(f => Math.hypot(f.x - first.x, f.y - first.y)))).toBeLessThan(3);
  }
  await expect(root).toHaveAttribute("data-layout-people", "5");
  let sharedRequests = 0;
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/tree-layout") sharedRequests++; });
  const samples = await probe(page, "e2e-memorial-person");
  await root.locator('.flow-person[data-person-id="e2e-memorial-person"] .flow-expand-family').click();
  await expect(root).toHaveAttribute("data-layout-people", "7");
  await expect(root).toHaveAttribute("data-layout-ready", "true");
  await page.waitForTimeout(700);
  await samples.evaluate(s => s.stop());
  const frames = await samples.evaluate(s => s.frames), first = frames[0];
  expect(await samples.evaluate(s => s.entered)).toBe(true);
  expect(sharedRequests).toBe(0);
  await expect(root.locator('.flow-person[data-person-id="continuity-great-grandparent"]')).toHaveCount(0);
  await expect(root.locator('.flow-person[data-person-id="continuity-unrelated"]')).toHaveCount(0);
  expect(Math.max(...frames.map(f => Math.abs(f.zoom - first.zoom)))).toBeLessThan(0.00001);
  expect(Math.max(...frames.map(f => Math.hypot(f.x - first.x, f.y - first.y)))).toBeLessThan(3);
});
