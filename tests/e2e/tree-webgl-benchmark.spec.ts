import { expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, extname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import sharp from "sharp";
import ELK from "elkjs/lib/elk.bundled.js";
import { randomFamily } from "../layout-fixtures";
import { unionGeometry } from "../../src/domain/union-layout";
import { treeNodeSize } from "../../src/domain/tree-layout-constants";
import type { Family } from "../../src/domain/types";
import type { TreeGeometry } from "../../src/domain/tree-layout";
import type { Viewport } from "@xyflow/react";

test.use({
  trace: "off",
  viewport: { width: 1280, height: 720 },
  deviceScaleFactor: 1,
});

type Lab = {
  nodes: number;
  edges: number;
  center: { x: number; y: number };
  mount: (mode: "current" | "webgl") => Promise<void>;
  prepare: (zoom: number) => Promise<void>;
  gesture: (
    kind: "pan" | "zoom" | "handoff",
    zoom: number,
    duration: number,
  ) => Promise<{
    p95Ms: number;
    maxMs: number;
    over50Ms: number;
    updates: number;
    gpu: {
      setupMs: number;
      textureBytes: number;
      bufferBytes: number;
      batches: number;
      error: number;
    } | null;
  }>;
  cameraAt: (zoom: number) => Viewport;
  landmarks: (zoom: number) => { x: number; y: number }[];
};
declare global {
  interface Window {
    __renderLab: Lab;
  }
}

test("compare production scene components with a static WebGL2 prototype", async ({
  page,
}, testInfo) => {
  test.skip(
    !process.env.DREVO_WEBGL_BENCHMARK || testInfo.project.name !== "desktop",
  );
  test.setTimeout(600_000);
  const directory = join(tmpdir(), "drevo-render-lab");
  mkdirSync(directory, { recursive: true });
  const bundle = join(directory, "bundle");
  execFileSync(process.execPath, ["tests/render-lab/build.mjs"], {
    cwd: resolve(import.meta.dirname, "../.."),
    env: { ...process.env, DREVO_RENDER_LAB_DIST: bundle },
    stdio: "pipe",
  });
  const fixture = randomFamily(
    5,
    Number(process.env.DREVO_WEBGL_GENERATIONS || 9),
  );
  const family: Family = {
    title: "Замер",
    description: "",
    demo: true,
    people: fixture.map((person, index) => ({
      ...person,
      name: person.id,
      surname: "Тестов",
      patronymic: "",
      sex: index % 2 ? "m" : "f",
      birthPlace: "",
      sources: [],
      generation: 1,
      column: 0,
      needsReview: index % 11 === 0,
      photo: `/media/render-${index}.jpg`,
    })),
  };
  const graphHash = createHash("sha256")
    .update(JSON.stringify(fixture))
    .digest("hex");
  const layoutRevision = execFileSync("git", ["rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  let geometry: TreeGeometry, layoutMs: number;
  const layoutCached = !!process.env.DREVO_WEBGL_GEOMETRY;
  if (layoutCached) {
    // A cache must never mask local changes to layout code or the ELK dependency.
    execFileSync("git", [
      "diff",
      "HEAD",
      "--quiet",
      "--",
      "src/domain",
      "package-lock.json",
    ]);
    const cached = JSON.parse(
      readFileSync(process.env.DREVO_WEBGL_GEOMETRY!, "utf8"),
    );
    expect(cached.graphHash).toBe(graphHash);
    expect(cached.layoutRevision).toBe(layoutRevision);
    geometry = cached.geometry;
    layoutMs = cached.layoutMs;
    expect(geometry.nodeSize).toEqual(treeNodeSize());
  } else {
    const layoutStart = performance.now();
    const elk = new ELK({ algorithms: ["layered"] });
    geometry = await unionGeometry(
      family.people,
      (graph) => elk.layout(graph),
      false,
      [],
      treeNodeSize(),
    );
    // elk.bundled's Node fake worker has no terminate(); no background worker is created here.
    layoutMs = Math.round(performance.now() - layoutStart);
  }
  const hash = createHash("sha256")
    .update(JSON.stringify(geometry))
    .digest("hex");
  console.log(
    `webgl-fixture ${JSON.stringify({ people: family.people.length, layoutMs, layoutCached, hash })}`,
  );
  writeFileSync(join(directory, "geometry.json"), JSON.stringify(geometry));
  writeFileSync(
    join(directory, `geometry-${family.people.length}.json`),
    JSON.stringify({ geometry, layoutMs, graphHash, layoutRevision }),
  );
  await page.addInitScript(
    (input) => {
      Object.assign(window, { __labInput: input });
    },
    { family, geometry },
  );
  // Distinct deterministic JPEGs, matching server preview dimensions. No user's photos.
  const images = new Map<string, Buffer>();
  let payloadBytes = 0;
  for (let index = 0; index < family.people.length; index++) {
    const size = 400,
      pixels = Buffer.alloc(size * size * 3);
    let seed = index + 1;
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const face = Math.hypot((x - 200) / 85, (y - 145) / 110) < 1;
        const body = Math.hypot((x - 200) / 160, (y - 380) / 140) < 1;
        const value =
          (face
            ? 145 + (index % 65)
            : body
              ? 50 + (index % 60)
              : 195 + (index % 30)) +
          (seed >>> 27);
        const offset = (y * size + x) * 3;
        pixels[offset] = value;
        pixels[offset + 1] = value - (index % 18);
        pixels[offset + 2] = value - (index % 28);
      }
    for (const [variant, width, quality] of [
      ["tiny", 48, 45],
      ["thumb", 400, 76],
    ] as const) {
      const image = await sharp(pixels, {
        raw: { width: size, height: size, channels: 3 },
      })
        .resize(width, width)
        .jpeg({ quality })
        .toBuffer();
      images.set(`${index}-${variant}`, image);
      payloadBytes += image.length;
    }
  }
  await page.route("**/media/render-*.jpg?variant=*", (route) => {
    const url = new URL(route.request().url());
    const index = url.pathname.match(/render-(\d+)/)![1];
    return route.fulfill({
      contentType: "image/jpeg",
      body: images.get(`${index}-${url.searchParams.get("variant")}`)!,
      headers: { "Cache-Control": "public, max-age=3600" },
    });
  });
  await page.route("**/render-lab/**", (route) => {
    const requested = decodeURIComponent(
      new URL(route.request().url()).pathname.slice("/render-lab/".length),
    );
    const file = resolve(bundle, requested),
      within = relative(bundle, file);
    if (!within || within.startsWith("..") || isAbsolute(within))
      return route.abort();
    return route.fulfill({
      body: readFileSync(file),
      contentType:
        extname(file) === ".js"
          ? "application/javascript"
          : extname(file) === ".css"
            ? "text/css"
            : "text/html",
    });
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/render-lab/tests/render-lab/index.html");
  await expect
    .poll(() => page.evaluate(() => window.__renderLab?.nodes))
    .toBe(family.people.length);
  const session = await page.context().newCDPSession(page);
  const throttle = Number(process.env.DREVO_RENDER_CPU_THROTTLE || 1);
  await session.send("Performance.enable");
  await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const browserSession = await page.context().browser()!.newBrowserCDPSession();
  const system = await browserSession.send("SystemInfo.getInfo");
  await browserSession.detach();
  const device = {
    browser: page.context().browser()!.version(),
    gpu: system.gpu.devices,
    throttle,
    viewport: { width: 1280, height: 720, dpr: 1 },
    people: family.people.length,
    hash,
    layoutMs,
    layoutCached,
    payloadBytes,
  };
  console.log(`webgl-device ${JSON.stringify(device)}`);
  const metrics = async () =>
    Object.fromEntries(
      (await session.send("Performance.getMetrics")).metrics.map(
        ({ name, value }) => [name, value],
      ),
    );
  const results: unknown[] = [];
  const portraitPixels = new Map<number, number[][]>();
  const repeats = Number(process.env.DREVO_WEBGL_REPEATS || 3);
  const duration = Number(process.env.DREVO_WEBGL_DURATION || 4000);
  for (let repeat = 0; repeat < repeats; repeat++) {
    const order =
      repeat % 2
        ? (["webgl", "current"] as const)
        : (["current", "webgl"] as const);
    for (const renderer of order) {
      const setupStart = Date.now();
      await page.evaluate((mode) => window.__renderLab.mount(mode), renderer);
      await page.waitForLoadState("networkidle");
      const mountMs = Date.now() - setupStart;
      console.log(
        `webgl-mount ${JSON.stringify({ renderer, repeat, mountMs })}`,
      );
      for (const [kind, zoom] of [
        ["pan", 0.1],
        ["pan", 0.215],
        ["pan", 0.3],
        ["pan", 0.9],
        ["handoff", 0.17],
      ] as const) {
        await page.evaluate((value) => window.__renderLab.prepare(value), zoom);
        if (renderer === "current" && zoom >= 0.18)
          await expect(
            page.locator(".react-flow__edge").first(),
          ).toBeAttached();
        if (!repeat) {
          const screenshot = await page.screenshot({
            path: testInfo.outputPath(`${renderer}-${kind}-${zoom}.png`),
          });
          const pixels = await sharp(screenshot).removeAlpha().raw().toBuffer();
          const landmarks = await page.evaluate(
            (value) => window.__renderLab.landmarks(value),
            zoom,
          );
          const colors = landmarks.map(({ x, y }) => [
            ...pixels.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3),
          ]);
          if (renderer === "current") portraitPixels.set(zoom, colors);
          else {
            const reference = portraitPixels.get(zoom)!;
            expect(colors.length).toBe(reference.length);
            const matched = colors.filter((color, index) =>
              color.every(
                (value, channel) =>
                  Math.abs(value - reference[index][channel]) < 32,
              ),
            ).length;
            if (colors.length)
              expect(matched / colors.length).toBeGreaterThanOrEqual(0.9);
            console.log(
              `webgl-portrait-match ${JSON.stringify({ zoom, matched, total: colors.length })}`,
            );
          }
        }
        const before = await metrics();
        const frames = await page.evaluate(
          ({ kind, zoom, duration }) =>
            window.__renderLab.gesture(kind, zoom, duration),
          { kind, zoom, duration },
        );
        const after = await metrics();
        const result = {
          repeat,
          renderer,
          kind,
          zoom,
          throttle,
          ...frames,
          mountMs,
          scriptMs: Math.round(
            (after.ScriptDuration - before.ScriptDuration) * 1000,
          ),
          layoutMs: Math.round(
            (after.LayoutDuration - before.LayoutDuration) * 1000,
          ),
          styleMs: Math.round(
            (after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000,
          ),
          taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
          heapMB: Math.round(after.JSHeapUsedSize / 1024 / 1024),
        };
        results.push(result);
        console.log(`webgl-result ${JSON.stringify(result)}`);
        if (renderer === "webgl") expect(frames.gpu?.error).toBe(0);
      }
    }
  }
  expect(errors).toEqual([]);
  const report = JSON.stringify({ device, results }, null, 2);
  writeFileSync(
    join(directory, `results-${family.people.length}-cpu${throttle}.json`),
    report,
  );
  await testInfo.attach("webgl-comparison", {
    body: Buffer.from(report),
    contentType: "application/json",
  });
  await session.detach();
});
