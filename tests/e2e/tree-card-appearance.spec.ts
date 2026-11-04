import { expect, test } from "@playwright/test";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { build } from "vite";
import sharp from "sharp";

test.use({ launchOptions: {
  args: ["--enable-unsafe-swiftshader"],
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE } : {}),
} });

test("GPU cameos and text remain legible across scales", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  for (const entry of ["tests/e2e/tree-card-appearance-fixture.ts", ...(process.env.DREVO_CARD_COMPARE === "1" ? ["work/card-clarity-before.ts"] : [])]) {
    const bundle = await build({ configFile: false, publicDir: false, logLevel: "silent",
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [{ name: "fixture-imports", resolveId: source => source.startsWith("/src/") ? resolve(source.slice(1)) : undefined }],
      build: { write: false, minify: false, lib: { entry: resolve(entry), formats: ["es"] } } });
    const output = (Array.isArray(bundle) ? bundle[0] : bundle) as { output: { type: string; code?: string }[] };
    await page.route(`**/${entry}`, route => route.fulfill({ contentType: "text/javascript", body: output.output.find(item => item.type === "chunk")!.code! }));
  }
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => {
    const get = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (parameter: number) {
      return parameter === 37446 ? "Drevo GPU appearance test" : get.call(this, parameter);
    };
  });
  await page.goto("/");
  const result = await page.evaluate(async (compare) => {
    const moduleUrl = "/tests/e2e/tree-card-appearance-fixture.ts";
    const { createGpuScene, placeholder } = await import(/* @vite-ignore */ moduleUrl);
    const root = document.createElement("div");
    root.style.cssText = "position:fixed;inset:0;z-index:9999;background:white;overflow:auto;color:#283c36";
    document.body.append(root);
    const nodes = ["m", "f", "u"].map((sex, i) => ({
      id: `appearance-${i}`, type: "person", position: { x: i * 230, y: 0 }, width: 220, height: 264,
      data: { collapsed: false, childrenCount: 0, dimmed: false, person: {
        id: `appearance-${i}`, name: ["Александр", "Мария", "Алексей"][i],
        surname: ["Вьюхин", "Тестова", "Тестов"][i], patronymic: ["Петрович", "Степановна", "Иванович"][i],
        sex, birth: "1900", death: "1980", birthPlace: "", parents: [], spouses: [], sources: [], generation: 1, column: i,
      } },
    }));
    const failures: string[] = [];
    const renderers = [["После", createGpuScene]];
    if (compare) {
      const oldUrl = "/work/card-clarity-before.ts";
      renderers.unshift(["До", (await import(/* @vite-ignore */ oldUrl)).createGpuScene]);
    }
    const metrics: { zoom: number; renderer: string; bytes: number; pixels: string }[] = [];
    for (const zoom of [0.05, 0.24, 0.52, 1, 1.8]) {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:12px;align-items:start";
      root.append(row);
      for (const [title, create] of renderers) {
        const column = document.createElement("div");
        const label = document.createElement("div");
        label.textContent = `${title} ${zoom * 100}%`;
        column.append(label);
        row.append(column);
        const canvas = document.createElement("canvas");
        const width = 690 * zoom + 24, height = 264 * zoom + 24;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
        column.append(canvas);
        const draw = () => scene?.draw({ x: 12, y: 12, zoom }, width, height);
        const scene: ReturnType<typeof createGpuScene> = create(canvas, nodes, [], [], () => "родственник", draw, () => failures.push("GPU failure"));
        draw();
        await new Promise(resolve => setTimeout(resolve, 100));
        draw();
        metrics.push({ zoom, renderer: title, bytes: Number(canvas.dataset.gpuTextureBytes), pixels: canvas.toDataURL() });
      }
    }
    const references = document.createElement("div");
    references.style.cssText = "position:fixed;right:0;top:0;display:flex;background:white;z-index:10000";
    document.body.append(references);
    for (const [i, sex] of ["male", "female", "unknown"].entries()) {
      const card = document.createElement("div");
      card.className = "flow-person is-portrait-card";
      card.style.cssText = "width:132px;height:132px;border:0;padding:0;box-shadow:none;background:white";
      card.innerHTML = `<span data-reference="${i}" class="person-avatar ${sex}" style="display:block">${placeholder}</span>`;
      references.append(card);
    }
    const isolated = [];
    const canvas = document.createElement("canvas");
    for (const zoom of [0.05, 0.24]) {
      const variants = [];
      for (const prefix of ["", "ABCDEFGHIJKLMNOPQRSTUVWXYZабвгдежзийклмнопрстуфхцчшщъыьэюя"]) {
        const unrelated = { ...nodes[0], id: "offscreen", position: { x: 100000, y: 0 },
          data: { ...nodes[0].data, person: { ...nodes[0].data.person, name: prefix, surname: "", patronymic: "" } } };
        const scene = createGpuScene(canvas, [unrelated, ...nodes], [], [], () => "", () => {}, () => failures.push("isolation failure"));
        scene.draw({ x: 12, y: 12, zoom }, 690 * zoom + 24, 264 * zoom + 24);
        variants.push(canvas.toDataURL());
        scene.destroy();
      }
      isolated.push(variants);
    }
    return { failures, metrics, isolated };
  }, process.env.DREVO_CARD_COMPARE === "1");
  expect(result.failures).toEqual([]);
  for (const variants of result.isolated) {
    const pixels = await Promise.all(variants.map(value => sharp(Buffer.from(value.split(",")[1], "base64")).raw().toBuffer()));
    let error = 0;
    for (let i = 0; i < pixels[0].length; i++) error += Math.abs(pixels[0][i] - pixels[1][i]);
    expect(error / pixels[0].length, "offscreen names must not bleed into visible glyphs").toBeLessThan(0.1);
  }
  for (const metric of result.metrics) {
    expect(metric.bytes).toBeLessThan(38 * 1024 * 1024);
    writeFileSync(info.outputPath(`${metric.renderer === "До" ? "before" : "after"}-${metric.zoom}.png`), Buffer.from(metric.pixels.split(",")[1], "base64"));
  }
  const gpu = Buffer.from(result.metrics.find(m => m.renderer === "После" && m.zoom === 1)!.pixels.split(",")[1], "base64");
  for (let i = 0; i < 3; i++) {
    const native = await page.locator(`[data-reference="${i}"]`).screenshot();
    const expected = await sharp(native).flatten({ background: "white" }).removeAlpha().raw().toBuffer();
    const actual = await sharp(gpu).extract({ left: 56 + i * 230, top: 16, width: 132, height: 132 })
      .flatten({ background: "white" }).removeAlpha().raw().toBuffer();
    let error = 0, channels = 0;
    // Ignore the independently antialiased outer border/shadow; compare the
    // silhouette, decorative outline and palette against the actual DOM SVG.
    for (let y = 0; y < 132; y++) for (let x = 0; x < 132; x++) {
      if (Math.hypot(x - 65.5, y - 65.5) > 58) continue;
      for (let c = 0; c < 3; c++) { error += Math.abs(actual[(y * 132 + x) * 3 + c] - expected[(y * 132 + x) * 3 + c]); channels++; }
    }
    expect(error / channels, `cameo ${i} matches native SVG`).toBeLessThan(3);
  }
  await page.locator("[data-reference]").evaluateAll(elements => elements.forEach(el => el.parentElement!.parentElement!.remove()));
  await page.screenshot({ path: info.outputPath("card-comparison.png"), fullPage: true });
});
