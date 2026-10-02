import type { Page, TestInfo } from "@playwright/test";

/** Opt-in measurements of the production renderer after its worker has finished. */
export async function profileTreeRenderer(page: Page, testInfo: TestInfo) {
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const throttle = Number(process.env.DREVO_RENDER_CPU_THROTTLE || 1);
  await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const cpuProfile = !!process.env.DREVO_RENDER_CPU_PROFILE;
  const browserSession = await page.context().browser()!.newBrowserCDPSession();
  const { gpu } = await browserSession.send("SystemInfo.getInfo");
  console.log(`render-device ${JSON.stringify({ browser: page.context().browser()!.version(),
    gpu: gpu.devices, features: gpu.featureStatus })}`);
  await browserSession.detach();
  const results: unknown[] = [];
  const zoom = () => page.locator(".react-flow__viewport").evaluate((element) =>
    new DOMMatrix(getComputedStyle(element).transform).a);
  const metrics = async () => Object.fromEntries((await session.send("Performance.getMetrics"))
    .metrics.map(({ name, value }) => [name, value]));
  const targets = process.env.DREVO_RENDER_PROFILE_TARGETS
    ? process.env.DREVO_RENDER_PROFILE_TARGETS.split(",").map(Number)
    : [0.05, 0.15, 0.19, 0.3, 0.6, 0.9];
  for (const target of targets) {
    for (let attempt = 0; attempt < 20 && await zoom() < target; attempt++)
      await page.locator(".flow-camera-tools button").nth(1).click();
    await page.waitForTimeout(700);
    const scene = await page.evaluate(() => ({
      zoom: new DOMMatrix(getComputedStyle(document.querySelector(".react-flow__viewport")!).transform).a,
      cards: document.querySelectorAll(".react-flow__node").length,
      edges: document.querySelectorAll(".react-flow__edge").length,
      dom: document.querySelectorAll("*").length,
      pendingImages: [...document.images].filter((image) => !image.complete).length,
      renderer: document.querySelector<HTMLElement>(".tree-canvas")?.dataset.renderer,
      gpuTextureBytes: Number(document.querySelector<HTMLElement>(".tree-gpu-scene")?.dataset.gpuTextureBytes || 0),
      gpuBufferBytes: Number(document.querySelector<HTMLElement>(".tree-gpu-scene")?.dataset.gpuBufferBytes || 0),
    }));
    for (const gesture of ["idle", "pan", "zoom"] as const) {
      if (cpuProfile) {
        await session.send("Profiler.enable");
        await session.send("Profiler.start");
      }
      const before = await metrics();
      await page.evaluate(() => {
        const state = { active: true, gaps: [] as number[], last: 0,
          longTasks: [] as number[], observer: null as PerformanceObserver | null };
        state.observer = new PerformanceObserver((entries) => {
          state.longTasks.push(...entries.getEntries().map((entry) => entry.duration));
        });
        state.observer.observe({ type: "longtask" });
        Object.assign(window, { __renderProfile: state });
        const tick = (time: number) => {
          if (!state.active) return;
          if (state.last) state.gaps.push(time - state.last);
          state.last = time;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      const pane = await page.locator(".react-flow__pane").boundingBox();
      if (gesture === "idle") await page.waitForTimeout(2000);
      else if (pane) {
        const x = pane.x + pane.width / 2, y = pane.y + pane.height / 2;
        await page.mouse.move(x, y);
        if (gesture === "pan") {
          await page.mouse.down();
          await page.mouse.move(x + 150, y + 65, { steps: 80 });
          await page.mouse.move(x, y, { steps: 80 });
          await page.mouse.up();
        } else {
          await page.keyboard.down("Control");
          for (let index = 0; index < 24; index++) {
            await page.mouse.wheel(0, index < 12 ? -10 : 10);
            await page.waitForTimeout(30);
          }
          await page.keyboard.up("Control");
        }
      }
      const frames = await page.evaluate(() => {
        const state = (window as typeof window & { __renderProfile: {
          active: boolean; gaps: number[]; longTasks: number[];
          observer: PerformanceObserver;
        } }).__renderProfile;
        state.active = false;
        state.observer.disconnect();
        const sorted = state.gaps.sort((a, b) => a - b);
        return { count: sorted.length, p95Ms: Math.round(sorted[Math.floor(sorted.length * 0.95)] || 0),
          maxMs: Math.round(sorted.at(-1) || 0), over50Ms: sorted.filter((gap) => gap > 50).length,
          longTasks: state.longTasks.map(Math.round) };
      });
      const after = await metrics();
      const result = { target, gesture, throttle, ...scene, ...frames,
        durationMs: Math.round((after.Timestamp - before.Timestamp) * 1000),
        scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000),
        layoutMs: Math.round((after.LayoutDuration - before.LayoutDuration) * 1000),
        styleMs: Math.round((after.RecalcStyleDuration - before.RecalcStyleDuration) * 1000),
        taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000),
        heapMB: Math.round(after.JSHeapUsedSize / 1024 / 1024) };
      results.push(result);
      console.log(`render-profile ${JSON.stringify(result)}`);
      if (cpuProfile) {
        const { profile } = await session.send("Profiler.stop");
        await testInfo.attach(`cpu-${target}-${gesture}`, {
          body: Buffer.from(JSON.stringify(profile)), contentType: "application/json",
        });
      }
    }
    await page.screenshot({ path: testInfo.outputPath(`render-${target}.png`) });
  }
  await session.detach();
  await testInfo.attach("render-profile", {
    body: Buffer.from(JSON.stringify(results, null, 2)), contentType: "application/json",
  });
}
