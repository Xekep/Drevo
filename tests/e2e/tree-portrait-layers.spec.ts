import { expect, test, type Page } from "@playwright/test";
import { renderPortraits } from "./render-portraits";

type PortraitFrame = {
  preparing: boolean;
  growing: boolean;
  visible: boolean;
  portraits: number;
  decodedTiny: number;
  photoPixel: boolean;
  zoom: number;
};
type PortraitProbe = { frames: PortraitFrame[]; stop: () => void };

async function preparePortraitTree(page: Page, accountPerson: boolean) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const seed = data.family.people[0];
    data.family.people = Array.from({ length: 600 }, (_, index) => ({
      ...seed,
      id: `portrait-layer-${index}`,
      name: `Человек ${index}`,
      birth: `${1700 + (index % 12) * 24}-01-01`,
      parents: index % 12 ? [`portrait-layer-${index - 1}`] : [],
      spouses: [],
      sources: [],
      photo: "/media/portrait-layer.jpg",
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = accountPerson ? "portrait-layer-0" : null;
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args) {
      if (args[0] === "webgl2") return null;
      return Reflect.apply(getContext, this, args);
    } as typeof getContext;
    let geometry: {
      positions: [string, { x: number; y: number }][];
      nodeSize: { width: number; height: number };
    } | undefined;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent) => {
          if (event.data?.geometry?.positions) geometry = event.data.geometry;
        });
      }
    };
    const frames: PortraitFrame[] = [];
    let active = true;
    let decodedTiny = 0;
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = function (this: HTMLImageElement) {
      return Reflect.apply(decode, this, []).then(() => {
        if (this.src.includes("/media/portrait-layer.jpg?variant=tiny")) decodedTiny++;
      });
    };
    const photographedPhases = new Set<string>();
    let sampledCanvas: HTMLCanvasElement | null = null;
    const sample = () => {
      if (!active) return;
      const root = document.querySelector(".tree-canvas");
      const canvas = root?.querySelector<HTMLCanvasElement>(".tree-distant-portraits");
      const viewport = root?.querySelector<HTMLElement>(".react-flow__viewport");
      if (root && canvas && viewport) {
        if (sampledCanvas !== canvas) {
          sampledCanvas = canvas;
          photographedPhases.clear();
        }
        // Visibility can be overridden by a descendant. Opacity and display
        // hide the composed layer, so inspect them on every ancestor instead.
        let visible = getComputedStyle(canvas).visibility === "visible";
        for (let node: Element | null = canvas; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === "none" || Number(style.opacity) === 0) visible = false;
        }
        const preparing = root.classList.contains("is-growth-preparing");
        const growing = root.classList.contains("is-growing");
        const portraits = Number(canvas.dataset.portraitCount || 0);
        const phase = preparing ? "preparing" : growing ? "growing" : "settled";
        const matrix = new DOMMatrix(getComputedStyle(viewport).transform);
        // A face pixel from the generated JPEG is grey (~160), unlike the
        // pale solid placeholder. Read only until each phase has a real photo.
        if (portraits > 0 && geometry && !photographedPhases.has(phase)) {
          const bounds = canvas.getBoundingClientRect();
          const flowBounds = root.querySelector(".react-flow")!.getBoundingClientRect();
          const context = canvas.getContext("2d")!;
          for (const [id, point] of geometry.positions) {
            if (!id.startsWith("portrait-layer-")) continue;
            const x = flowBounds.x + matrix.e + (point.x + geometry.nodeSize.width / 2) * matrix.a;
            const y = flowBounds.y + matrix.f + (point.y + 70) * matrix.a;
            if (x < flowBounds.left || x >= flowBounds.right || y < flowBounds.top || y >= flowBounds.bottom) continue;
            const px = Math.floor((x - bounds.x) * canvas.width / bounds.width);
            const py = Math.floor((y - bounds.y) * canvas.height / bounds.height);
            if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) continue;
            const color = context.getImageData(px, py, 1, 1).data;
            if (color[3] > 0 && color[0] > 90 && color[0] < 190 &&
                Math.abs(color[0] - color[1]) <= 3 && Math.abs(color[1] - color[2]) <= 3) {
              photographedPhases.add(phase);
              break;
            }
          }
        }
        frames.push({ preparing, growing, visible, portraits, decodedTiny,
          photoPixel: photographedPhases.has(phase), zoom: matrix.a });
        if (frames.length > 4000) frames.shift();
      }
      requestAnimationFrame(sample);
    };
    Object.assign(window, { __portraitLayerProbe: { frames, stop: () => { active = false; } } });
    requestAnimationFrame(sample);
  });
}

async function frames(page: Page): Promise<PortraitFrame[]> {
  return page.evaluate(() =>
    (window as typeof window & { __portraitLayerProbe: PortraitProbe }).__portraitLayerProbe.frames,
  );
}

test("decoded tiny portraits stay hidden while the introduction waits for full portraits", async ({ page }) => {
  test.setTimeout(60_000);
  await preparePortraitTree(page, true);
  const images = await renderPortraits(["layer"]);
  let releaseThumbs!: () => void;
  const thumbGate = new Promise<void>((resolve) => { releaseThumbs = resolve; });
  let thumbRequested = false;
  await page.route("**/media/portrait-layer.jpg?variant=*", async (route) => {
    const variant = new URL(route.request().url()).searchParams.get("variant");
    if (variant === "thumb") {
      thumbRequested = true;
      await thumbGate;
    }
    await route.fulfill({ contentType: "image/jpeg", body: images.get(`layer-${variant}`)! });
  });
  try {
    await page.goto("/tree", { waitUntil: "domcontentloaded" });
    await expect.poll(() => thumbRequested).toBe(true);
    await expect.poll(async () => (await frames(page)).some((frame) =>
      frame.preparing && frame.decodedTiny > 0,
    ), { timeout: 30_000 }).toBe(true);
    const preparing = (await frames(page)).filter((frame) => frame.preparing);
    expect(preparing.length).toBeGreaterThan(0);
    expect(preparing.filter((frame) => frame.visible)).toEqual([]);
    releaseThumbs();
    await expect.poll(async () => (await frames(page)).some((frame) =>
      frame.growing && !frame.preparing && frame.visible && frame.portraits > 0 && frame.photoPixel,
    ), { timeout: 30_000 }).toBe(true);
  } finally {
    releaseThumbs();
    await page.evaluate(() =>
      (window as typeof window & { __portraitLayerProbe?: PortraitProbe }).__portraitLayerProbe?.stop(),
    );
  }
});

test("timeline removes the distant portrait layer and returning to the tree restores photographs", async ({ page, isMobile }) => {
  test.setTimeout(60_000);
  await preparePortraitTree(page, false);
  const images = await renderPortraits(["layer"]);
  await page.route("**/media/portrait-layer.jpg?variant=*", (route) => {
    const variant = new URL(route.request().url()).searchParams.get("variant");
    return route.fulfill({ contentType: "image/jpeg", body: images.get(`layer-${variant}`)! });
  });
  await page.goto("/tree");
  const root = page.locator(".tree-canvas");
  await expect(root).not.toHaveClass(/is-grow|is-layout-settling/, { timeout: 30_000 });
  await expect(root).toHaveAttribute("data-gpu-fallback", "WebGL2 unavailable");
  await expect.poll(async () => (await frames(page)).some((frame) =>
    !frame.preparing && !frame.growing && frame.zoom < 0.18 && frame.visible && frame.photoPixel,
  )).toBe(true);
  if (isMobile) await page.getByRole("switch", { name: "Древо / Хронология" }).click();
  else await page.getByRole("button", { name: "Хронология", exact: true }).click();
  await expect(root).toHaveClass(/mode-timeline/);
  await expect(page.locator(".tree-distant-portrait-clip")).toHaveCount(0);
  const timeline = page.getByRole("region", { name: /Горизонтальная хронология/ });
  await expect(timeline).toBeVisible();
  const year = Number(await page.locator(".timeline-center-marker output").textContent());
  await timeline.evaluate((element) => { element.scrollLeft += 120; });
  await expect.poll(async () => Number(await page.locator(".timeline-center-marker output").textContent()))
    .toBeGreaterThan(year);
  // Reset phase evidence: returning must paint a new canvas, not retain the
  // successful sample from before the timeline replaced the tree.
  await page.evaluate(() => {
    (window as typeof window & { __portraitLayerProbe: PortraitProbe }).__portraitLayerProbe.frames.length = 0;
  });
  if (isMobile) await page.getByRole("switch", { name: "Древо / Хронология" }).click();
  else await page.getByRole("button", { name: "Древо", exact: true }).click();
  await expect(root).toHaveClass(/mode-generations/);
  await expect(page.locator(".tree-distant-portraits")).toBeVisible();
  await expect.poll(async () => (await frames(page)).some((frame) =>
    frame.zoom < 0.18 && frame.visible && frame.portraits > 0 && frame.photoPixel,
  )).toBe(true);
  await page.evaluate(() =>
    (window as typeof window & { __portraitLayerProbe: PortraitProbe }).__portraitLayerProbe.stop(),
  );
});
