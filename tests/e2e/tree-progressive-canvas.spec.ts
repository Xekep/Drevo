import { expect, test, type Page } from "@playwright/test";

async function routeLargeFamily(page: Page, withRelations = false) {
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.family.people = Array.from({ length: 3000 }, (_, index) => ({
      id: `growth-${index}`, name: `Person ${index}`, surname: "Test",
      sex: "m", birth: `${1700 + (index % 12) * 24}-01-01`,
      patronymic: "", birthPlace: "",
      parents: index % 12 ? [`growth-${index - 1}`] : [],
      spouses: [], sources: [], generation: (index % 12) + 1,
      column: Math.floor(index / 12),
    }));
    data.family.links = [];
    if (withRelations) {
      data.family.people[1500].spouses = ["growth-1512"];
      data.family.people[1512].spouses = ["growth-1500"];
      data.family.people[1512].birth = "1712-01-01";
      data.family.links = [{ id: "spike-godparent", from: "growth-2381",
        to: "growth-2394", type: "godparent" }];
    }
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
}

test("3000 person canvas intro reveals cards and lines before GPU handoff", async ({ page }) => {
  test.setTimeout(60_000);
  await routeLargeFamily(page);
  await page.addInitScript(() => {
    const samples: unknown[] = [];
    Object.assign(window, { __canvasIntroSamples: samples });
    const states: unknown[] = [];
    Object.assign(window, { __canvasIntroStates: states });
    const handoff: unknown[] = [];
    Object.assign(window, { __canvasIntroHandoff: handoff });
    let observed = false;
    let contentShown = false;
    const sample = () => {
      const root = document.querySelector(".tree-canvas");
      const canvas = document.querySelector<HTMLCanvasElement>(".tree-distant-portraits");
      if (root && !observed) {
        observed = true;
        const record = () => states.push({ at: Math.round(performance.now()),
          className: root.className, renderer: root.getAttribute("data-renderer") });
        record();
        new MutationObserver(record).observe(root, { attributes: true,
          attributeFilter: ["class", "data-renderer"] });
      }
      if (root?.classList.contains("is-growing") && canvas) {
        samples.push({ at: Math.round(performance.now()),
          partial: Number(canvas.dataset.introPartialEdges || 0),
          edges: Number(canvas.dataset.introVisibleEdges || 0),
          nodes: Number(canvas.dataset.introVisibleNodes || 0),
          sceneEdges: Number(canvas.dataset.sceneEdges || 0),
          svgEdges: root.querySelectorAll(".react-flow__edge").length,
          visible: getComputedStyle(canvas).visibility,
          clipVisible: getComputedStyle(canvas.parentElement!).visibility,
          preparing: root.classList.contains("is-growth-preparing"),
          zoom: new DOMMatrix(getComputedStyle(root.querySelector(".react-flow__viewport")!).transform).a,
        });
      }
      if (root && states.some((state) => String((state as { className: string }).className).includes("is-growing"))) {
        const gpu = root.querySelector<HTMLCanvasElement>(".tree-gpu-scene");
        const canvasVisible = !!canvas && getComputedStyle(canvas).visibility === "visible" &&
            getComputedStyle(canvas.parentElement!).visibility === "visible" &&
            Number(canvas.dataset.sceneEdges || 0) > 0;
        const gpuVisible = !!gpu && getComputedStyle(gpu).visibility === "visible" &&
            Number(gpu.dataset.gpuDraws || 0) > 0;
        if (canvasVisible || gpuVisible) contentShown = true;
        if (contentShown) handoff.push({ at: Math.round(performance.now()),
          canvas: canvasVisible, gpu: gpuVisible });
      }
      if (!root || root.getAttribute("data-renderer") !== "webgl2")
        requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.goto("/tree");
  const root = page.locator(".tree-canvas");
  await expect(root).toHaveAttribute("data-renderer", "webgl2", { timeout: 30_000 });
  const samples = await page.evaluate(() =>
    (window as typeof window & { __canvasIntroSamples: Array<{
      at: number; partial: number; edges: number; nodes: number;
      sceneEdges: number; svgEdges: number; visible: string;
      clipVisible: string; preparing: boolean; zoom: number;
    }> }).__canvasIntroSamples);
  const states = await page.evaluate(() =>
    (window as typeof window & { __canvasIntroStates: Array<{
      at: number; className: string; renderer: string;
    }> }).__canvasIntroStates);
  const handoff = await page.evaluate(() =>
    (window as typeof window & { __canvasIntroHandoff: Array<{
      at: number; canvas: boolean; gpu: boolean;
    }> }).__canvasIntroHandoff);
  const progress = samples.filter((sample) => !sample.preparing &&
    sample.visible === "visible" && sample.clipVisible === "visible" && sample.partial > 0);
  expect(progress.length).toBeGreaterThanOrEqual(2);
  expect(new Set(progress.map((sample) => sample.partial)).size).toBeGreaterThanOrEqual(2);
  expect(Math.max(...samples.map((sample) => sample.sceneEdges))).toBeGreaterThanOrEqual(2500);
  expect(Math.max(...samples.map((sample) => sample.svgEdges))).toBe(0);
  const visible = samples.filter((sample) => !sample.preparing && sample.clipVisible === "visible");
  // Culling changes the number of cards and lines between desktop and mobile.
  // Require distinct visible card and line phases across three generations.
  const phases: string[] = [];
  let nodes = 0, edges = 0;
  for (const sample of visible) {
    const cardAdvanced = sample.nodes > nodes;
    const lineAdvanced = sample.edges > edges;
    const phase = cardAdvanced && lineAdvanced ? "both" :
      cardAdvanced ? "card" : lineAdvanced ? "line" : "";
    if (phase && phase !== phases.at(-1)) phases.push(phase);
    nodes = Math.max(nodes, sample.nodes);
    edges = Math.max(edges, sample.edges);
  }
  expect(phases.slice(0, 6)).toEqual(["card", "line", "card", "line", "card", "line"]);
  expect(handoff.filter((frame) => !frame.canvas && !frame.gpu)).toEqual([]);
  await expect(page.locator(".tree-gpu-scene")).toBeVisible();
  expect(Number(await page.locator(".tree-gpu-scene").getAttribute("data-scene-edges")))
    .toBeGreaterThanOrEqual(2500);
  console.log("CANVAS_INTRO_PROFILE", JSON.stringify({
    project: test.info().project.name,
    firstVisible: visible.find((sample) => sample.nodes > 0 || sample.edges > 0)?.at,
    started: states.find((state) => state.className.includes("is-growing"))?.at,
    gpuReady: states.find((state) => state.renderer === "webgl2")?.at,
    frames: visible.length,
    phases: phases.slice(0, 6),
    handoffFrames: handoff.length,
  }));
});

test("large intro retains the camera input lock", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  test.setTimeout(60_000);
  await routeLargeFamily(page);
  await page.goto("/tree");
  const root = page.locator(".tree-canvas");
  await expect(root).toHaveClass(/is-growing/, { timeout: 15_000 });
  await expect(root).not.toHaveClass(/is-growth-preparing/);
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  await page.mouse.move(900, 500);
  await page.mouse.down();
  await page.mouse.move(1000, 550, { steps: 3 });
  await page.mouse.up();
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, -240);
  await page.keyboard.up("Control");
  await page.mouse.click(800, 400);
  expect(await viewport.getAttribute("style")).toBe(before);
  expect(page.url()).toMatch(/\/tree$/);
  await expect(root).toHaveAttribute("data-renderer", "webgl2", { timeout: 30_000 });
});

test("additional relation labels return after the large intro", async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  test.setTimeout(60_000);
  await routeLargeFamily(page, true);
  await page.goto("/tree");
  const root = page.locator(".tree-canvas");
  await expect(root).toHaveAttribute("data-renderer", "webgl2", { timeout: 30_000 });
  await expect(page.locator(".tree-extra-toggle")).toHaveAttribute("aria-pressed", "false");
  await page.locator(".tree-extra-toggle").click();
  await expect(page.locator(".tree-extra-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".relationship-godparent")).toHaveCount(1);
  await expect(page.locator(".tree-grow-edge-label")).not.toHaveCount(0);
});
