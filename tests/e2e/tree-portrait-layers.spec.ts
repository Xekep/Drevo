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

async function preparePortraitTree(page: Page, accountPerson: boolean,
  options: { count?: number; photos?: boolean; uniquePhotos?: boolean } = {}) {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const seed = data.family.people[0];
    data.family.people = Array.from({ length: options.count ?? 600 }, (_, index) => ({
      ...seed,
      id: `portrait-layer-${index}`,
      name: `Человек ${index}`,
      birth: `${1700 + (index % 12) * 24}-01-01`,
      parents: index % 12 ? [`portrait-layer-${index - 1}`] : [],
      spouses: [],
      sources: [],
      photo: options.photos === false ? "" : options.uniquePhotos
        ? `/media/portrait-layer-${index}.jpg` : "/media/portrait-layer.jpg",
      sex: ["m", "f", "u"][index % 3],
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
    Object.assign(window, { __portraitLayerProbe: { frames, geometry: () => geometry,
      stop: () => { active = false; } } });
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

test("distant portraits load only the current view and cancel decoded work when chronology replaces it", async ({ page, isMobile }) => {
  test.setTimeout(60_000);
  await preparePortraitTree(page, true, { count: 1000, uniquePhotos: true });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const state = { previews: 0 };
    Object.assign(window, { __viewportPortraits: state });
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (image: CanvasImageSource, ...args: number[]) {
      if (this.canvas.width === 48 && image instanceof HTMLImageElement && image.src.includes("variant=tiny"))
        state.previews++;
      return Reflect.apply(draw, this, [image, ...args]);
    };
  });
  const images = await renderPortraits(["viewport"]);
  const tinyRequests: string[] = [];
  let releasedRequests = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/media/portrait-layer-*.jpg?variant=*", async (route) => {
    const url = new URL(route.request().url());
    const tiny = url.searchParams.get("variant") === "tiny";
    if (tiny) {
      tinyRequests.push(url.pathname);
      await gate;
    }
    try {
      await route.fulfill({ contentType: "image/jpeg", body: images.get(tiny ? "viewport-tiny" : "viewport-thumb")! });
    } catch (error) {
      // The test deliberately aborts these requests before releasing replies.
      if (!tiny) throw error;
    } finally {
      if (tiny) releasedRequests++;
    }
  });
  try {
    await page.goto("/tree");
    const root = page.locator(".tree-canvas");
    await expect(root).not.toHaveClass(/is-grow|is-layout-settling/, { timeout: 30_000 });
    const zoom = () => page.locator(".react-flow__viewport").evaluate((element) =>
      new DOMMatrix(getComputedStyle(element).transform).a);
    await expect.poll(zoom).toBeGreaterThan(0.18);
    await expect(page.locator(".flow-person .person-avatar img").first()).toBeAttached();
    // The personal camera can pass through the fitted overview before settling.
    // Those cancelled requests belong to that earlier visible area.
    const initialRequests = tinyRequests.length;
    expect(initialRequests).toBeLessThan(1000);
    tinyRequests.length = 0;
    await root.evaluate((element) => {
      const box = element.getBoundingClientRect();
      element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
        ctrlKey: true, deltaY: 700, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
    });
    await expect.poll(zoom).toBeLessThan(0.18);
    await expect.poll(() => tinyRequests.length).toBeGreaterThan(0);
    // All responses remain pending: the queue must stay bounded and must not
    // even request the rest of the archive's thousand distinct photographs.
    expect(tinyRequests.length).toBeLessThanOrEqual(12);
    expect(await page.evaluate((requested) => {
      const state = window as typeof window & { __portraitLayerProbe: {
        geometry: () => { positions: [string, { x: number; y: number }][]; nodeSize: { width: number } } | undefined;
      } };
      const geometry = state.__portraitLayerProbe.geometry()!;
      const positions = new Map(geometry.positions);
      const flow = document.querySelector<HTMLElement>(".react-flow")!;
      const matrix = new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform);
      return requested.every((path) => {
        const id = path.match(/(portrait-layer-\d+)\.jpg$/)![1];
        const point = positions.get(id)!;
        const left = matrix.e + (point.x + geometry.nodeSize.width / 2 - 66) * matrix.a;
        const top = matrix.f + (point.y + 4) * matrix.a;
        return left + 132 * matrix.a >= -256 && top + 132 * matrix.a >= -256 &&
          left <= flow.clientWidth + 256 && top <= flow.clientHeight + 256;
      });
    }, tinyRequests)).toBe(true);
    if (isMobile) await page.getByRole("switch", { name: "Древо / Хронология" }).click();
    else await page.getByRole("button", { name: "Хронология", exact: true }).click();
    await expect(page.locator(".tree-distant-portrait-clip")).toHaveCount(0);
    const requested = tinyRequests.length;
    const before = await page.evaluate(() => (window as typeof window & { __viewportPortraits: { previews: number } }).__viewportPortraits.previews);
    release();
    await expect.poll(() => releasedRequests).toBe(initialRequests + requested);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(tinyRequests).toHaveLength(requested);
    expect(await page.evaluate(() => (window as typeof window & { __viewportPortraits: { previews: number } }).__viewportPortraits.previews)).toBe(before);
  } finally {
    release();
    await page.evaluate(() =>
      (window as typeof window & { __portraitLayerProbe?: PortraitProbe }).__portraitLayerProbe?.stop(),
    );
  }
});

for (const count of [180, 1000]) {
  test(`zoomed-out ${count}-person tree keeps cameos without portraits`, async ({ page }, testInfo) => {
    test.setTimeout(60_000);
    await preparePortraitTree(page, false, { count, photos: false });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const mediaRequests: string[] = [];
    page.on("request", (request) => {
      if (/\/(?:media|portrait)\//.test(new URL(request.url()).pathname))
        mediaRequests.push(request.url());
    });
    await page.addInitScript(() => {
      const draw = CanvasRenderingContext2D.prototype.drawImage;
      const sources = new Set<HTMLCanvasElement>();
      CanvasRenderingContext2D.prototype.drawImage = function (image: CanvasImageSource, ...args: number[]) {
        if (this.canvas.classList.contains("tree-distant-portraits") &&
          image instanceof HTMLCanvasElement && image.width === 48)
          sources.add(image);
        return Reflect.apply(draw, this, [image, ...args]);
      };
      Object.assign(window, { __cameoSources: () => sources.size });
    });
    await page.goto("/tree");
    const root = page.locator(".tree-canvas");
    await expect(root).not.toHaveClass(/is-grow|is-layout-settling/, { timeout: 30_000 });
    const zoom = () => page.locator(".react-flow__viewport").evaluate((element) =>
      new DOMMatrix(getComputedStyle(element).transform).a);
    const zoomBy = async (direction: "in" | "out") => {
      const before = await zoom();
      // Exercise the app's zoom handler without Android Chrome's page zoom.
      await root.evaluate((element, deltaY) => {
        const box = element.getBoundingClientRect();
        element.dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true,
          ctrlKey: true, deltaY, clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 }));
      }, direction === "in" ? -100 : 100);
      if (direction === "in") await expect.poll(zoom).toBeGreaterThan(before);
      else await expect.poll(zoom).toBeLessThan(before);
    };
    for (let index = 0; index < 12 && await zoom() >= 0.18; index++)
      await zoomBy("out");
    for (let index = 0; index < 12 && await zoom() < 0.09; index++)
      await zoomBy("in");
    await expect.poll(zoom).toBeLessThan(0.18);
    if (count < 600) {
      const cameo = page.locator(".flow-person.is-distant .portrait-placeholder");
      await expect(cameo.first()).toBeAttached();
      await expect(cameo.first().locator("path")).toHaveCount(1);
      await expect(cameo.first().locator("ellipse")).toHaveCount(1);
      await expect(cameo.first().locator("circle")).toHaveCount(0);
    } else {
      await expect(root).toHaveAttribute("data-gpu-fallback", "WebGL2 unavailable");
      await expect.poll(() => page.evaluate(() =>
        (window as typeof window & { __cameoSources: () => number }).__cameoSources(),
      )).toBeGreaterThan(0);
      expect(await page.evaluate(() =>
        (window as typeof window & { __cameoSources: () => number }).__cameoSources(),
      )).toBeLessThanOrEqual(3);
      // Sample the actual composed canvas, not a source tile or a DOM counter.
      await expect.poll(() => page.evaluate(() => {
        const state = window as typeof window & { __portraitLayerProbe: {
          geometry: () => { positions: [string, { x: number; y: number }][];
            nodeSize: { width: number } } | undefined } };
        const geometry = state.__portraitLayerProbe.geometry();
        const root = document.querySelector(".tree-canvas")!;
        const canvas = root.querySelector<HTMLCanvasElement>(".tree-distant-portraits")!;
        const context = canvas.getContext("2d")!;
        const bounds = canvas.getBoundingClientRect();
        const flow = root.querySelector(".react-flow")!.getBoundingClientRect();
        const matrix = new DOMMatrix(getComputedStyle(root.querySelector(".react-flow__viewport")!).transform);
        for (const [, point] of geometry?.positions || []) {
          const x = flow.x + matrix.e + (point.x + geometry!.nodeSize.width / 2) * matrix.a;
          const y = flow.y + matrix.f + (point.y + 53.5) * matrix.a;
          if (x < flow.left + 20 || x > flow.right - 20 || y < flow.top + 100 || y > flow.bottom - 50) continue;
          const sample = (offset: number) => context.getImageData(
            Math.floor((x + offset * matrix.a - bounds.x) * canvas.width / bounds.width),
            Math.floor((y - bounds.y) * canvas.height / bounds.height), 1, 1).data;
          const head = sample(0), flank = sample(40);
          if (head[3] > 200 && flank[3] > 200 && flank[0] - head[0] > 12) return true;
        }
        return false;
      })).toBe(true);
      await zoomBy("out");
      await zoomBy("in");
      expect(await page.evaluate(() =>
        (window as typeof window & { __cameoSources: () => number }).__cameoSources(),
      )).toBeLessThanOrEqual(3);
    }
    for (let index = 0; index < 8 && await zoom() < 0.2; index++) await zoomBy("in");
    await expect(page.locator(".flow-person:not(.is-distant) .portrait-placeholder circle").first())
      .toBeAttached();
    for (let index = 0; index < 8 && await zoom() >= 0.18; index++) await zoomBy("out");
    if (count < 600)
      await expect(page.locator(".flow-person.is-distant .portrait-placeholder ellipse").first()).toBeAttached();
    else expect(await page.evaluate(() =>
      (window as typeof window & { __cameoSources: () => number }).__cameoSources(),
    )).toBeLessThanOrEqual(3);
    expect(mediaRequests).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath(`cameos-${count}.png`) });
    await page.evaluate(() =>
      (window as typeof window & { __portraitLayerProbe: PortraitProbe }).__portraitLayerProbe.stop(),
    );
  });
}

test("timeline removes the distant portrait layer and returning to the tree restores photographs", async ({ page, isMobile }) => {
  test.setTimeout(60_000);
  await preparePortraitTree(page, false);
  const images = await renderPortraits(["layer"]);
  await page.route("**/media/portrait-layer.jpg?variant=*", (route) => {
    const variant = new URL(route.request().url()).searchParams.get("variant");
    return route.fulfill({ contentType: "image/jpeg", body: images.get(`layer-${variant}`) || images.get("layer-thumb")! });
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
