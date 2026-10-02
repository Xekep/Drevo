import { expect, test, type Page, type CDPSession } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  installTreeAcceptanceProbe,
  readTreeAcceptanceProbe,
} from "./tree-acceptance-probe";
import { randomFamily } from "../layout-fixtures";

// Explicitly opt in: real temporary backend, production build, no HTTP routing.
test.use({ trace: "off" });
test("cold tree, persistent reload and scope cycles retain a bounded GPU scene", async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(process.env.DREVO_TREE_ACCEPTANCE !== "1");
  test.setTimeout(600_000);
  const count = Number(process.env.DREVO_TREE_ACCEPTANCE_PEOPLE || 977);
  expect([977, 3313]).toContain(count);
  const throttle = Number(process.env.DREVO_TREE_ACCEPTANCE_CPU || 1);
  const fixture = randomFamily(5, count === 977 ? 9 : 12);
  expect(fixture.length).toBe(count);
  // The server starts listening before generating the opt-in media fixture.
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          "/api/family?projection=overview",
        );
        return (await response.json()).totals?.people;
      },
      { timeout: 180_000, intervals: [500, 1000] },
    )
    .toBe(count);
  await installTreeAcceptanceProbe(page);
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  await session.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  const browserSession = await page.context().browser()!.newBrowserCDPSession();
  const { gpu } = await browserSession.send("SystemInfo.getInfo");
  await browserSession.detach();
  let mediaRequests = 0,
    mediaFailures = 0,
    pendingMedia = 0,
    peakPendingMedia = 0;
  const previews: Record<
    string,
    { responses: number; bytes: number; jpeg: number }
  > = {};
  let mediaDocument = 0;
  const pending = new Map<
    import("@playwright/test").Request,
    { document: number; startedAt: number; status?: number }
  >();
  const describePending = () =>
    [...pending].map(([request, state]) => ({
      url: request.url(),
      document: state.document,
      ageMs: Date.now() - state.startedAt,
      status: state.status,
      failure: request.failure()?.errorText || null,
    }));
  const precedingDocumentRequests: ReturnType<typeof describePending>[] = [];
  const reloadDocument = async () => {
    // Navigation retires this document. A late/missing cancellation event from
    // it must not participate in the new document's network-idle assertion.
    // Keep the retired requests as evidence rather than silently losing them.
    const retiring = describePending();
    precedingDocumentRequests.push(retiring);
    if (retiring.length)
      console.log(
        "tree-acceptance media document retired " + JSON.stringify(retiring),
      );
    pending.clear();
    pendingMedia = 0;
    mediaDocument++;
    await page.reload();
  };
  page.on("request", (request) => {
    if (!new URL(request.url()).pathname.startsWith("/media/")) return;
    mediaRequests++;
    pending.set(request, { document: mediaDocument, startedAt: Date.now() });
    pendingMedia = pending.size;
    peakPendingMedia = Math.max(peakPendingMedia, pendingMedia);
  });
  const finishRequest = (request: import("@playwright/test").Request) => {
    if (pending.delete(request)) pendingMedia = pending.size;
  };
  page.on("requestfinished", finishRequest);
  page.on("requestfailed", finishRequest); // Camera changes may intentionally abort old portraits.
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (!url.pathname.startsWith("/media/")) return;
    const state = pending.get(response.request());
    if (state) state.status = response.status();
    if (response.status() >= 400) mediaFailures++;
    const variant = url.searchParams.get("variant") || "original";
    const stats = (previews[variant] ||= { responses: 0, bytes: 0, jpeg: 0 });
    stats.responses++;
    stats.bytes += Number(response.headers()["content-length"] || 0);
    if (response.headers()["content-type"]?.includes("image/jpeg"))
      stats.jpeg++;
  });
  const waitForMediaIdle = async () => {
    try {
      await expect.poll(() => pendingMedia, { timeout: 30_000 }).toBe(0);
    } catch (error) {
      const diagnostics = {
        url: page.url(),
        document: mediaDocument,
        pendingMedia,
        pending: describePending(),
        precedingDocumentRequests,
      };
      console.log(
        "tree-acceptance media idle failure " + JSON.stringify(diagnostics),
      );
      await testInfo.attach("media-idle-diagnostics", {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: "application/json",
      });
      throw error;
    }
  };
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const phases: unknown[] = [];
  const metrics = async () =>
    Object.fromEntries(
      (await session.send("Performance.getMetrics")).metrics.map(
        ({ name, value }) => [name, value],
      ),
    );
  const snapshot = async (phase: string) => {
    const probe = await readTreeAcceptanceProbe(page);
    const counters = await metrics();
    const scene = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>(".tree-canvas");
      const canvas = root?.querySelector<HTMLCanvasElement>(".tree-gpu-scene");
      const viewport = root?.querySelector(".react-flow__viewport");
      return {
        renderer: root?.dataset.renderer,
        fallback: root?.dataset.gpuFallback,
        nodes: Number(canvas?.dataset.sceneNodes || 0),
        textureBytes: Number(canvas?.dataset.gpuTextureBytes || 0),
        bufferBytes: Number(canvas?.dataset.gpuBufferBytes || 0),
        dom: document.querySelectorAll("*").length,
        mountedCards: document.querySelectorAll(".react-flow__node-person")
          .length,
        mountedEdges: document.querySelectorAll(".react-flow__edge").length,
        zoom: viewport
          ? new DOMMatrix(getComputedStyle(viewport).transform).a
          : 0,
      };
    });
    const result = {
      phase,
      ...probe,
      ...scene,
      mediaRequests,
      pendingMedia,
      peakPendingMedia,
      mediaFailures,
      previews: structuredClone(previews),
      heapBytes: counters.JSHeapUsedSize,
      scriptMs: counters.ScriptDuration * 1000,
    };
    phases.push(result);
    console.log("tree-acceptance " + JSON.stringify(result));
    if (scene.renderer === "webgl2") {
      expect(scene.textureBytes).toBeLessThanOrEqual(38 * 1024 * 1024);
      expect(scene.bufferBytes).toBeLessThan(24 * 1024 * 1024);
      expect(scene.mountedCards).toBeLessThan(25);
      expect(scene.mountedEdges).toBe(0);
    }
    return result;
  };
  const fullReady = async () => {
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-ready",
      "true",
      { timeout: 180_000 },
    );
    await expect.poll(async () => {
      const root = page.locator(".tree-canvas");
      return await root.getAttribute("data-renderer") === "webgl2" ||
        !!await root.getAttribute("data-gpu-fallback");
    }, { timeout: 180_000 }).toBe(true);
    const fallback = await page.locator(".tree-canvas").getAttribute("data-gpu-fallback");
    if (fallback) await snapshot("gpu-fallback");
    expect(fallback, "Production GPU initialization must succeed for this fixture").toBeFalsy();
    await expect(page.locator(".tree-gpu-scene")).toHaveAttribute(
      "data-scene-nodes",
      String(count),
    );
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-growing|is-layout-settling/,
      { timeout: 30_000 },
    );
    await waitForMediaIdle();
  };
  const stored = () =>
    page.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const request = indexedDB.open("drevo-layout-cache", 1);
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result,
              tx = db.transaction("layouts");
            const count = tx.objectStore("layouts").count();
            count.onsuccess = () => resolve(count.result);
            tx.oncomplete = () => db.close();
          };
        }),
    );
  const workerCount = async () =>
    (await readTreeAcceptanceProbe(page)).requests.length;
  const settings = async () => {
    await page.getByRole("button", { name: "Настройки древа" }).click();
    return page.getByRole("dialog", { name: "Вид древа" });
  };
  await page.goto("/tree");
  await fullReady();
  const cold = await snapshot("cold-ready");
  expect(cold.requests).toHaveLength(1);
  expect(cold.requests[0].people).toBe(count);
  expect(cold.requests[0].completedAt).toBeGreaterThan(
    cold.requests[0].requestedAt,
  );
  expect(cold.portraitUploads).toBeGreaterThan(0);
  // Full-resolution portraits must be limited to the viewport/intro vicinity.
  // Mounting the whole archive at React Flow's initial zoom used to fetch all.
  expect(cold.previews.thumb?.responses || 0).toBeLessThan(100);
  await expect.poll(stored, { timeout: 15_000 }).toBeGreaterThan(0);
  // Same context retains real HTTP policy and IndexedDB. Private portraits use no-store.
  await reloadDocument();
  await fullReady();
  const warm = await snapshot("persistent-reload");
  expect(warm.requests).toHaveLength(0);
  const stableResources = warm.resources;
  // Explicit GC checkpoints measure retained JS heap, not natural peak memory.
  await session.send("HeapProfiler.collectGarbage");
  const retainedHeapBefore = (await metrics()).JSHeapUsedSize;
  for (const gesture of ["pan", "zoom"] as const) {
    await readTreeAcceptanceProbe(page, true);
    const before = await workerCount();
    await moveCamera(page, session, isMobile, gesture);
    await waitForMediaIdle();
    const result = await snapshot(gesture);
    expect(result.requests).toHaveLength(before);
    expect(result.resources).toMatchObject({
      textures: stableResources.textures,
      programs: stableResources.programs,
    });
    // A second portrait batch can be allocated when quality crosses to thumb.
    expect(result.resources.buffers).toBeLessThanOrEqual(
      stableResources.buffers + 1,
    );
  }
  // Selection/profile must neither calculate layout nor allocate a fresh GPU scene.
  await page.locator(".tree-canvas").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await expect(page.locator(".inspector-dock")).toBeVisible();
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-renderer",
    "webgl2",
  );
  const opened = await snapshot("card-open");
  expect(opened.resources).toMatchObject({
    textures: stableResources.textures,
    programs: stableResources.programs,
  });
  expect(await workerCount()).toBe(0);
  await page
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
  await expect(page.locator(".inspector-dock")).not.toBeVisible();
  // Repeated large -> small -> large transitions should reuse geometry and release GL.
  const profileScope = process.env.DREVO_TREE_ACCEPTANCE_PROFILE === "1";
  if (profileScope) {
    await session.send("Profiler.enable");
    await session.send("Profiler.start");
  }
  let scopedRequests = 0;
  for (let cycle = 0; cycle < 3; cycle++) {
    await readTreeAcceptanceProbe(page, true);
    const dialog = await settings();
    await dialog
      .getByRole("switch", { name: "Ограничить видимое древо" })
      .check();
    await dialog
      .getByRole("combobox", { name: "Относительно человека" })
      .selectOption("g-0-0");
    await dialog.getByRole("radio", { name: "Вниз: 1", exact: true }).check();
    await dialog
      .getByRole("radio", { name: "Боковые ветви: 0", exact: true })
      .check();
    await dialog.getByRole("button", { name: "Закрыть" }).click();
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-ready",
      "true",
      { timeout: 60_000 },
    );
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-people",
      "14",
    );
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-renderer",
      "react-flow",
    );
    await expect(page.locator(".tree-canvas")).not.toHaveClass(
      /is-growing|is-layout-settling/,
      { timeout: 60_000 },
    );
    await expect
      .poll(
        async () => {
          const stage = await page.locator(".react-flow").boundingBox();
          const node = await page
            .locator(
              '.react-flow__node:has(.flow-person[data-person-id="g-0-0"])',
            )
            .first()
            .boundingBox();
          return stage && node
            ? Math.max(
                Math.abs(node.x + node.width / 2 - stage.x - stage.width / 2),
                Math.abs(node.y + node.height / 2 - stage.y - stage.height / 2),
              )
            : Infinity;
        },
        { timeout: 15_000 },
      )
      .toBeLessThan(16);
    const scoped = await snapshot("scope-small-" + cycle);
    expect(scoped.resources).toEqual({ textures: 0, buffers: 0, programs: 0 });
    // Each control saves immediately; intermediate projections may be cancelled.
    // Restoring the full view itself must always reuse the cached geometry.
    scopedRequests = await workerCount();
    const restore = await settings();
    await restore
      .getByRole("switch", { name: "Ограничить видимое древо" })
      .uncheck();
    await restore.getByRole("button", { name: "Закрыть" }).click();
    await fullReady();
    const restored = await snapshot("scope-full-" + cycle);
    expect(restored.requests).toHaveLength(scopedRequests);
    expect(restored.resources).toMatchObject({
      textures: stableResources.textures,
      programs: stableResources.programs,
    });
    expect(restored.resources.buffers).toBeLessThanOrEqual(
      stableResources.buffers + 1,
    );
    if (profileScope && cycle === 0) {
      const { profile } = await session.send("Profiler.stop");
      await writeFile(testInfo.outputPath("scope.cpuprofile"), JSON.stringify(profile));
      await session.send("Profiler.disable");
      // Profiling is a separate diagnostic run, never an acceptance result.
      await session.detach();
      return;
    }
  }
  await session.send("HeapProfiler.collectGarbage");
  const retainedHeapAfter = (await metrics()).JSHeapUsedSize;
  // Exercise actual HTTP edits in the disposable database; text preserves geometry,
  // a layout input change invalidates it. No response routing or application hooks.
  for (const field of ["name", "birth"] as const) {
    const current = await (await page.request.get("/api/family")).json();
    const person = current.family.people.find(
      (entry: { id: string }) => entry.id === "f-0",
    );
    const response = await page.request.post("/api/family/changes", {
      headers: {
        "If-Match": String(current.revision),
        Origin: new URL(page.url()).origin,
      },
      data: {
        changes: [
          {
            collection: "people",
            id: person.id,
            field,
            before: person[field],
            after: field === "name" ? "Имя после правки" : "1900-01-01",
          },
        ],
      },
    });
    expect(response.status()).toBe(200);
    await reloadDocument();
    await fullReady();
    const edited = await snapshot(field + "-edit-reload");
    expect(edited.requests).toHaveLength(field === "name" ? 0 : 1);
    expect(edited.resources).toMatchObject({
      textures: stableResources.textures,
      programs: stableResources.programs,
    });
    expect(edited.resources.buffers).toBeLessThanOrEqual(
      stableResources.buffers + 1,
    );
  }
  expect(mediaFailures).toBe(0);
  expect(peakPendingMedia).toBeLessThan(100);
  expect(errors).toEqual([]);
  const report = {
    date: new Date().toISOString(),
    commit: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    fixture: {
      seed: 5,
      generations: count === 977 ? 9 : 12,
      people: count,
      synthetic: true,
    },
    sourceHashes: Object.fromEntries(
      [
        "src/components/tree/tree-canvas.tsx",
        "src/components/tree/person-node.tsx",
        "src/components/tree/tree-node-model.ts",
        "src/components/research-assistant.tsx",
        "src/components/tree/gpu-scene.ts",
        "src/components/tree/distant-portraits.tsx",
        "src/components/tree/use-tree-layout.ts",
        "src/components/tree/layout-cache.ts",
        "src/components/tree/layout-storage.ts",
        "src/domain/union-layout.ts",
        "package-lock.json",
      ].map((file) => [
        file,
        createHash("sha256").update(readFileSync(file)).digest("hex"),
      ]),
    ),
    device: {
      browser: page.context().browser()!.version(),
      gpu: gpu.devices,
      features: gpu.featureStatus,
      project: testInfo.project.name,
      viewport: page.viewportSize(),
      cpuThrottle: throttle,
    },
    method:
      "Production application, disposable SQLite/backend JPEG/previews, no response routing. Navigation timestamps are performance.now; resource counts are explicit allocations, not total VRAM. Mobile is Chrome touch emulation, not a physical phone. No GPU eligibility override. One run.",
    phases,
    retainedHeap: {
      beforeScopeCycles: retainedHeapBefore,
      afterScopeCycles: retainedHeapAfter,
      method:
        "CDP forced GC checkpoints, main-thread JS heap only; excludes GPU/Worker/browser memory",
    },
  };
  const json = JSON.stringify(report, null, 2);
  await writeFile(testInfo.outputPath("tree-acceptance.json"), json);
  await testInfo.attach("tree-acceptance", {
    body: json,
    contentType: "application/json",
  });
  await page.screenshot({ path: testInfo.outputPath("tree-acceptance.png") });
  await session.detach();
});

async function moveCamera(
  page: Page,
  session: CDPSession,
  mobile: boolean,
  gesture: "pan" | "zoom",
) {
  const box = (await page.locator(".react-flow__pane").boundingBox())!;
  const x = Math.round(box.x + box.width * 0.55),
    y = Math.round(box.y + box.height * 0.65);
  const viewport = page.locator(".react-flow__viewport");
  const before = await viewport.getAttribute("style");
  if (!mobile) {
    await page.mouse.move(x, y);
    if (gesture === "pan") {
      await page.mouse.down({ button: "middle" });
      await page.mouse.move(x + 100, y + 60, { steps: 60 });
      await expect(viewport).not.toHaveAttribute("style", before!);
      await page.mouse.move(x, y, { steps: 60 });
      await page.mouse.up({ button: "middle" });
    } else {
      await page.keyboard.down("Control");
      for (let index = 0; index < 24; index++) {
        await page.mouse.wheel(0, index < 12 ? -12 : 12);
        await page.waitForTimeout(30);
        if (index === 11)
          await expect(viewport).not.toHaveAttribute("style", before!);
      }
      await page.keyboard.up("Control");
    }
    return;
  }
  const touches = (progress: number) =>
    gesture === "pan"
      ? [
          {
            x: x + Math.round(progress * 80),
            y: y + Math.round(progress * 50),
            id: 1,
          },
        ]
      : [
          { x: x - 30 - Math.round(progress * 25), y, id: 1 },
          { x: x + 30 + Math.round(progress * 25), y, id: 2 },
        ];
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: touches(0),
  });
  for (let step = 1; step <= 60; step++) {
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: touches(step <= 30 ? step / 30 : (60 - step) / 30),
    });
    await page.waitForTimeout(16);
    if (step === 30)
      await expect(viewport).not.toHaveAttribute("style", before!);
  }
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
}
