import { expect, test } from "@playwright/test";
import { readdir } from "node:fs/promises";
import sharp from "sharp";
import type { SpatialRenderer } from "../../src/components/tree/spatial-renderer";
import type { Person } from "../../src/domain";

test("nearby arrow pixels move without camera motion and stop outside the radius", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
    Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
  });
  await page.setViewportSize({ width: 600, height: 600 });
  const chunk = (await readdir("dist/assets")).find(name => /^spatial-renderer-.*\.js$/.test(name));
  expect(chunk).toBeTruthy();
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: /^Люди(?:\s|$)/ })).toBeVisible();
  await page.evaluate(async chunk => {
    const module = await import(`/assets/${chunk}`);
    const Renderer = Object.values(module).find(value => typeof value === "function" && value.prototype?.personAt) as typeof SpatialRenderer;
    const host = document.createElement("div");
    host.id = "arrow-motion-scene";
    host.style.cssText = "position:fixed;inset:0;width:400px;height:400px;background:#fff;z-index:100";
    document.body.append(host);
    const points = new Map([['a', { x: 0, y: 200, z: 0, angle: 0 }], ['b', { x: 0, y: -200, z: 0, angle: 0 }]]);
    const people = new Map([...points.keys()].map(id => [id, {
      id, name: id, surname: "", patronymic: "", sex: "u", birth: "", birthPlace: "",
      parents: [], spouses: [], sources: [], generation: 1, column: 0,
    } as Person]));
    const scene = new Renderer(host, { points, connections: [{ from: 'a', to: 'b', type: 'parent' }] }, people,
      { paper: "#fff", ink: "#000", muted: "#00ff00", green: "#00ff00", red: "#900" },
      { choose() {}, select() {}, profile() {}, failure() { throw Error("WebGL failed"); } });
    scene.camera.position.set(0, 0, 1000);
    scene.controls.target.set(0, 0, 0);
    scene.controls.update();
    scene.invalidate();
    (window as unknown as { arrowMotion: SpatialRenderer }).arrowMotion = scene;
  }, chunk!);
  const host = page.locator("#arrow-motion-scene");
  await expect(host).toHaveAttribute("data-depth-animated-arrows", "1");
  const pixels = async () => sharp(await host.screenshot()).resize(400, 400)
    .extract({ left: 190, top: 160, width: 20, height: 120 }).removeAlpha().raw().toBuffer();
  const before = await pixels();
  await expect.poll(async () => {
    const after = await pixels();
    let changed = 0;
    for (let i = 0; i < before.length; i += 3)
      if (Math.abs(before[i] - after[i]) + Math.abs(before[i + 1] - after[i + 1]) + Math.abs(before[i + 2] - after[i + 2]) > 60) changed++;
    return changed;
  }).toBeGreaterThan(5);
  await page.evaluate(() => {
    const scene = (window as unknown as { arrowMotion: SpatialRenderer }).arrowMotion;
    scene.camera.position.set(0, 0, 20_000);
    scene.controls.update();
    scene.invalidate();
  });
  await expect(host).toHaveAttribute("data-depth-animated-arrows", "0");
  const frames = await host.getAttribute("data-depth-arrow-frames");
  await page.waitForTimeout(300);
  await expect(host).toHaveAttribute("data-depth-arrow-frames", frames!);
  await page.evaluate(() => (window as unknown as { arrowMotion: SpatialRenderer }).arrowMotion.dispose());
});

test("near edges cross distant portraits while near portraits hide distant edges", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 600, height: 600 });
  const chunk = (await readdir("dist/assets")).find(name => /^spatial-renderer-.*\.js$/.test(name));
  expect(chunk).toBeTruthy();
  const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#ff0000" } }).png().toBuffer();
  await page.route("**/media/depth-face.png*", route => route.fulfill({ contentType: "image/png", body: png }));
  await page.goto("/people");
  await expect(page.getByRole("heading", { name: /^Люди(?:\s|$)/ })).toBeVisible();
  await page.evaluate(async chunk => {
    const module = await import(`/assets/${chunk}`);
    const Renderer = Object.values(module).find(value => typeof value === "function" && value.prototype?.personAt) as typeof SpatialRenderer;
    const host = document.createElement("div");
    host.id = "edge-depth-scene";
    host.style.cssText = "position:fixed;inset:0;width:400px;height:400px;background:#fff;z-index:100";
    document.body.append(host);
    const focal = 200 / Math.tan(42 * Math.PI / 360);
    const y = 30 / focal * 600;
    const points = new Map([
      ["face", { x: 0, y: 0, z: 0, angle: 0 }],
      ["a", { x: -1500, y, z: 400, angle: 0 }],
      ["b", { x: 1500, y, z: 400, angle: 0 }],
    ]);
    const people = new Map([...points.keys()].map(id => [id, {
      id, name: id, surname: "Портрет", patronymic: "", sex: "u", birth: "", birthPlace: "",
      photo: id === "face" ? "/media/depth-face.png" : undefined,
      parents: [], spouses: [], sources: [], generation: 1, column: 0,
    } as Person]));
    const world = { points, connections: [{ from: "a", to: "b", type: "parent" as const }] };
    const scene = new Renderer(host, world, people,
      { paper: "#fff", ink: "#000", muted: "#00ff00", green: "#00ff00", red: "#900" },
      { choose() {}, select() {}, profile() {}, failure() { throw Error("WebGL failed"); } });
    scene.camera.position.set(0, 0, 1000);
    scene.controls.target.set(0, 0, 0);
    scene.controls.update();
    scene.invalidate();
    (window as unknown as { edgeDepth: { scene: SpatialRenderer; points: typeof points; world: typeof world; people: typeof people } }).edgeDepth = { scene, points, world, people };
  }, chunk!);
  const host = page.locator("#edge-depth-scene");
  await expect(host).toHaveAttribute("data-depth-cards", "1");
  const redPoint = async () => {
    const { data, info: pixels } = await sharp(await host.screenshot()).resize(400, 400).raw().toBuffer({ resolveWithObject: true });
    const i = (180 * 400 + 200) * pixels.channels;
    return [...data.subarray(i, i + 3)];
  };
  const greenPixels = async () => {
    const { data, info: pixels } = await sharp(await host.screenshot()).resize(400, 400).raw().toBuffer({ resolveWithObject: true });
    let green = 0;
    for (let y = 166; y <= 174; y++) for (let x = 195; x <= 205; x++) {
      const i = (y * 400 + x) * pixels.channels;
      // A subpixel antialiased green line blends with red at fractional DPR.
      // Its green contribution must survive; it need not dominate red.
      if (data[i + 1] > 30 && data[i + 1] > data[i + 2] + 30) green++;
    }
    return green;
  };
  await expect.poll(redPoint).toEqual([255, 0, 0]);
  await host.screenshot({ path: info.outputPath("edge-before-depth-assertion.png") });
  await expect.poll(greenPixels).toBeGreaterThan(5);
  await host.screenshot({ path: info.outputPath("edge-in-front-of-face.png") });
  await page.evaluate(() => {
    const state = (window as unknown as { edgeDepth: { scene: SpatialRenderer; points: Map<string, { x: number; y: number; z: number; angle: number }>; world: ConstructorParameters<typeof SpatialRenderer>[1]; people: Map<string, Person> } }).edgeDepth;
    state.scene.dispose();
    for (const id of ["a", "b"]) Object.assign(state.points.get(id)!, { z: -400, y: 30 / (200 / Math.tan(42 * Math.PI / 360)) * 1400 });
    // Create the actual renderer again: both edge buffers and label depths change.
    const Constructor = state.scene.constructor as typeof SpatialRenderer;
    state.scene = new Constructor(document.querySelector("#edge-depth-scene") as HTMLDivElement, state.world, state.people,
      { paper: "#fff", ink: "#000", muted: "#00ff00", green: "#00ff00", red: "#900" },
      { choose() {}, select() {}, profile() {}, failure() { throw Error("WebGL failed"); } });
    state.scene.camera.position.set(0, 0, 1000);
    state.scene.controls.target.set(0, 0, 0);
    state.scene.controls.update();
    state.scene.invalidate();
  });
  await expect(host).toHaveAttribute("data-depth-cards", "1");
  await expect.poll(redPoint).toEqual([255, 0, 0]);
  await expect.poll(greenPixels).toBe(0);
  await host.screenshot({ path: info.outputPath("face-in-front-of-edge.png") });
  await page.evaluate(() => (window as unknown as { edgeDepth: { scene: SpatialRenderer } }).edgeDepth.scene.dispose());
});

// Isolated, deterministic camera/points exercise the real production shader.
// No app data, force simulation or screenshot baseline can hide a depth error.
for (const reverse of [false, true]) {
  test(`near portraits occlude distant portraits and glyphs, insertion reversed=${reverse}`, async ({ page, isMobile }, info) => {
    await page.setViewportSize({ width: 600, height: 600 });
    const chunk = (await readdir("dist/assets"))
      .find(name => /^spatial-renderer-.*\.js$/.test(name));
    expect(chunk).toBeTruthy();
    for (const [name, color] of [["near", "#ff0000"], ["far", "#0000ff"]]) {
      const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: color } }).png().toBuffer();
      await page.route(`**/media/occlusion-${name}*`, route => route.fulfill({ contentType: "image/png", body: png }));
    }
    await page.goto("/people");
    await expect(page.getByRole("heading", { name: /^Люди(?:\s|$)/ })).toBeVisible();
    await page.evaluate(async ({ chunk, reverse }) => {
      const module = await import(`/assets/${chunk}`);
      const Renderer = Object.values(module).find(value => typeof value === "function" &&
        value.prototype?.personAt) as typeof SpatialRenderer;
      const host = document.createElement("div");
      host.id = "occlusion-scene";
      host.style.cssText = "position:fixed;inset:0;width:400px;height:400px;background:#fff;z-index:100";
      document.body.append(host);
      const ids = reverse ? ["far", "near"] : ["near", "far"];
      const people = new Map(ids.map(id => [id, {
        id, name: id === "near" ? "Ближний" : "Дальний", surname: "Портрет", patronymic: "",
        photo: `/media/occlusion-${id}.png`, sex: "m", birth: "1900", birthPlace: "",
        parents: [], spouses: [], sources: [], generation: 1, column: 0,
      } as Person]));
      const points = new Map(ids.map(id => [id, { x: 0, y: 0, z: id === "near" ? 100 : -100, angle: 0 }]));
      const scene = new Renderer(host, { points, connections: [] }, people,
        { paper: "#fff", ink: "#000", muted: "#555", green: "#333", red: "#900" },
        { choose() {}, select() {}, profile() {}, failure() { throw new Error("WebGL failed"); } });
      scene.camera.position.set(0, 0, 1000);
      scene.controls.target.set(0, 0, 0);
      scene.controls.update();
      scene.invalidate();
      (window as unknown as { occlusion: { scene: SpatialRenderer; points: typeof points } }).occlusion = { scene, points };
    }, { chunk: chunk!, reverse });
    const host = page.locator("#occlusion-scene");
    await expect(host).toHaveAttribute("data-depth-cards", "2");
    // Wait for both real atlas image decodes, then require a painted red area.
    const sample = async () => {
      const { data, info: pixels } = await sharp(await host.screenshot()).resize(400, 400).raw().toBuffer({ resolveWithObject: true });
      const offset = (170 * 400 + 200) * pixels.channels;
      return [...data.subarray(offset, offset + 3)];
    };
    await expect.poll(sample).toEqual([255, 0, 0]);
    // Move the far surname over the near portrait: separate text and portrait
    // batches must share depth, rather than always drawing all names on top.
    const frame = Number(await host.getAttribute("data-depth-frames"));
    await page.evaluate(() => {
      const { scene, points } = (window as unknown as { occlusion: { scene: SpatialRenderer; points: Map<string, { y: number }> } }).occlusion;
      points.get("far")!.y = 88;
      // Rebuild the name buffers through the real data update boundary.
      const people = new Map(["near", "far"].map(id => [id, {
        id, name: id === "near" ? "Ближний" : "Дальний", surname: "Портрет", patronymic: "",
        photo: `/media/occlusion-${id}.png`, sex: "m", birth: "1900", birthPlace: "",
        parents: [], spouses: [], sources: [], generation: 1, column: 0,
      } as Person]));
      scene.update(people, "", new Set(), { choose() {}, select() {}, profile() {}, failure() {} });
    });
    await expect.poll(async () => Number(await host.getAttribute("data-depth-frames"))).toBeGreaterThan(frame);
    await expect.poll(sample).toEqual([255, 0, 0]);
    const { data, info: pixels } = await sharp(await host.screenshot()).resize(400, 400).raw().toBuffer({ resolveWithObject: true });
    let redPixels = 0;
    for (let y = 162; y < 180; y++) for (let x = 185; x < 215; x++) {
      const offset = (y * 400 + x) * pixels.channels;
      if (data[offset] > 250 && data[offset + 1] < 5 && data[offset + 2] < 5) redPixels++;
    }
    expect(redPixels / (18 * 30)).toBeGreaterThan(.99);
    if (!isMobile) {
      const calls = await host.getAttribute("data-depth-draw-calls");
      const textures = await host.getAttribute("data-depth-textures");
      await page.mouse.move(200, 170);
      await expect(host).toHaveAttribute("data-depth-hovered", "near");
      await expect(host.locator("canvas")).toHaveCSS("cursor", "pointer");
      const highlighted = await sharp(await host.screenshot()).resize(400, 400).raw().toBuffer();
      let changed = 0;
      for (let y = 115; y < 195; y++) for (let x = 155; x < 245; x++) {
        const offset = (y * 400 + x) * pixels.channels;
        if (Math.abs(data[offset] - highlighted[offset]) > 40) changed++;
      }
      expect(changed, "hover must paint a visible portrait rim").toBeGreaterThan(60);
      await host.screenshot({ path: info.outputPath("portrait-hover.png") });
      await expect(host).toHaveAttribute("data-depth-draw-calls", calls!);
      await expect(host).toHaveAttribute("data-depth-textures", textures!);
      const frames = await host.getAttribute("data-depth-frames");
      await page.mouse.move(202, 172);
      await page.waitForTimeout(100);
      await expect(host).toHaveAttribute("data-depth-frames", frames!);
      await page.mouse.move(450, 450);
      await expect(host).toHaveAttribute("data-depth-hovered", "");
      await expect(host.locator("canvas")).toHaveCSS("cursor", "grab");
      await expect.poll(sample).toEqual([255, 0, 0]);
    }
    await host.screenshot({ path: info.outputPath("near-over-far.png") });
    await page.evaluate(() => (window as unknown as { occlusion: { scene: SpatialRenderer } }).occlusion.scene.dispose());
  });
}
