import { expect, test } from "@playwright/test";

test("spike: 3000 person canvas intro paints progressive edges", async ({ page }) => {
  test.setTimeout(60_000);
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
    if (process.env.DREVO_SPIKE_RELATIONS) {
      data.family.people[1500].spouses = ["growth-1512"];
      data.family.people[1512].spouses = ["growth-1500"];
      data.family.people[1512].birth = "1712-01-01";
      data.family.links = [{ id: "spike-godparent", from: "growth-1500",
        to: "growth-1513", type: "godparent" }];
    }
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
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
  await page.goto(process.env.DREVO_SPIKE_PERSON ? "/tree?person=growth-0" : "/tree");
  const root = page.locator(".tree-canvas");
  await expect(root).toHaveAttribute("data-renderer", "webgl2", { timeout: 30_000 });
  const samples = await page.evaluate(() =>
    (window as typeof window & { __canvasIntroSamples: Array<{
      at: number; partial: number; edges: number; nodes: number;
      sceneEdges: number; svgEdges: number; visible: string;
      clipVisible: string; preparing: boolean; zoom: number;
    }> }).__canvasIntroSamples);
  console.log("CANVAS_SPIKE", JSON.stringify(samples));
  console.log("CANVAS_STATES", JSON.stringify(await page.evaluate(() =>
    (window as typeof window & { __canvasIntroStates: unknown[] }).__canvasIntroStates)));
  const handoff = await page.evaluate(() =>
    (window as typeof window & { __canvasIntroHandoff: Array<{
      at: number; canvas: boolean; gpu: boolean;
    }> }).__canvasIntroHandoff);
  console.log("CANVAS_HANDOFF", JSON.stringify({ frames: handoff.length,
    blank: handoff.filter((frame) => !frame.canvas && !frame.gpu).map((frame) => frame.at) }));
  const progress = samples.filter((sample) => !sample.preparing &&
    sample.visible === "visible" && sample.clipVisible === "visible" && sample.partial > 0);
  expect(progress.length).toBeGreaterThanOrEqual(2);
  expect(new Set(progress.map((sample) => sample.partial)).size).toBeGreaterThanOrEqual(2);
  expect(Math.max(...samples.map((sample) => sample.sceneEdges))).toBeGreaterThanOrEqual(2500);
  expect(Math.max(...samples.map((sample) => sample.svgEdges))).toBe(0);
  const visible = samples.filter((sample) => !sample.preparing && sample.clipVisible === "visible");
  // Three consecutive generations have a visible parent card, then its line,
  // then a child card. The fixture contributes 112 visible cards per level.
  if (!process.env.DREVO_SPIKE_RELATIONS) for (const count of [112, 224, 336]) {
    expect(visible.some((sample) => sample.nodes >= count && sample.edges < count)).toBe(true);
    expect(visible.some((sample) => sample.nodes <= count && sample.edges >= count)).toBe(true);
  }
  expect(handoff.filter((frame) => !frame.canvas && !frame.gpu)).toEqual([]);
  await expect(page.locator(".tree-gpu-scene")).toBeVisible();
  expect(Number(await page.locator(".tree-gpu-scene").getAttribute("data-scene-edges")))
    .toBeGreaterThanOrEqual(2500);
  if (process.env.DREVO_SPIKE_RELATIONS) {
    expect(Math.max(...samples.map((sample) => sample.sceneEdges))).toBeGreaterThan(2750);
    await expect(page.locator(".tree-extra-toggle")).toHaveAttribute("aria-pressed", "false");
    await page.locator(".tree-extra-toggle").click();
    await expect(page.locator(".tree-extra-toggle")).toHaveAttribute("aria-pressed", "true");
    console.log("RELATION_AFTER_TOGGLE", JSON.stringify(await root.evaluate((element) => ({
      viewport: element.querySelector(".react-flow__viewport")?.getAttribute("style"),
      extraEdges: element.querySelectorAll(".relationship-godparent").length,
      labels: element.querySelectorAll(".tree-grow-edge-label").length,
      gpuEdges: element.querySelector(".tree-gpu-scene")?.getAttribute("data-scene-edges"),
    }))));
    await expect(page.locator(".relationship-godparent")).toHaveCount(1);
    await expect(page.locator(".tree-grow-edge-label")).not.toHaveCount(0);
  }
});
