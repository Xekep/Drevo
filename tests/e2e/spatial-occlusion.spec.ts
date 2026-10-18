import { expect, test } from "@playwright/test";
import { readdir } from "node:fs/promises";
import sharp from "sharp";
import type { SpatialRenderer } from "../../src/components/tree/spatial-renderer";
import type { Person } from "../../src/domain";

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
