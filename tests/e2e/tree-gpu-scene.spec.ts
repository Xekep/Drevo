import { expect, test } from "@playwright/test";
import { randomFamily } from "../layout-fixtures";
import { profileTreeRenderer } from "./tree-render-profile";
import sharp from "sharp";
import { renderPortraits } from "./render-portraits";

test.use({
  trace: "retain-on-failure",
  launchOptions: {
    args: [
      "--enable-unsafe-swiftshader",
      ...(process.env.DREVO_GPU_SOFTWARE === "1"
        ? ["--use-angle=swiftshader"]
        : ["gl", "d3d11", "vulkan"].includes(process.env.DREVO_E2E_ANGLE || "")
          ? [`--use-angle=${process.env.DREVO_E2E_ANGLE}`]
          : []),
    ],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  },
});
test("3313 desktop / 503 mobile GPU tree keeps bounded labels, one camera and context-loss fallback", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const started = Date.now();
  const stage = (name: string) =>
    console.log("GPU functional stage", name, Date.now() - started);
  const people =
    process.env.DREVO_GPU_PEOPLE === "977"
      ? randomFamily(5, 9)
      : testInfo.project.name === "desktop"
        ? randomFamily(5, 12)
        : randomFamily(1, 6);
  if (process.env.DREVO_GPU_CPU_THROTTLE) {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setCPUThrottlingRate", {
      rate: Number(process.env.DREVO_GPU_CPU_THROTTLE),
    });
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    // CI uses SwiftShader. Exercise the shaders and interaction path there too;
    // production detection still falls back on software renderers.
    const get = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (
      parameter: number,
    ) {
      return parameter === 37446
        ? "Drevo GPU integration test"
        : get.call(this, parameter);
    };
    const gpuResources = { programs: 0, glyphUploads: 0 };
    Object.assign(window, { __gpuResources: gpuResources });
    const portraitUploads = { count: 0 };
    Object.assign(window, { __gpuPortraitUploads: portraitUploads });
    WebGL2RenderingContext.prototype.texSubImage2D = new Proxy(
      WebGL2RenderingContext.prototype.texSubImage2D,
      {
        apply(target, thisArg, args) {
          const result = Reflect.apply(target, thisArg, args);
          portraitUploads.count++;
          return result;
        },
      },
    );
    WebGL2RenderingContext.prototype.createProgram = new Proxy(
      WebGL2RenderingContext.prototype.createProgram,
      {
        apply(target, thisArg, args) {
          gpuResources.programs++;
          return Reflect.apply(target, thisArg, args);
        },
      },
    );
    WebGL2RenderingContext.prototype.texImage2D = new Proxy(
      WebGL2RenderingContext.prototype.texImage2D,
      {
        apply(target, thisArg, args) {
          const source = args[5];
          if (
            source instanceof HTMLCanvasElement &&
            source.width === 1024 &&
            source.height === 1024
          )
            gpuResources.glyphUploads++;
          return Reflect.apply(target, thisArg, args);
        },
      },
    );
    const state = {
      requests: 0,
      positions: [] as [string, { x: number; y: number }][],
      width: 220,
      occurrences: [] as { id: string; personId: string }[],
    };
    Object.assign(window, { __gpuLayout: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent) => {
          if (event.data?.geometry?.positions) {
            state.positions = event.data.geometry.positions;
            state.width = event.data.geometry.nodeSize.width;
            state.occurrences = event.data.geometry.occurrences;
          }
        });
      }
      postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        if (message && typeof message === "object" && "people" in message)
          state.requests++;
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.family.people = people.map((person, index) => ({
      ...person,
      sex: index % 2 ? "f" : "m",
      name: person.id,
      surname: "Тестов",
      patronymic: "",
      birthPlace: "",
      sources: [],
      generation: 1,
      column: 0,
      photo: `/media/gpu-${person.id}.jpg`,
      needsReview: true,
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  const portraits = process.env.DREVO_RENDER_PROFILE
    ? await renderPortraits(people.map((person) => person.id))
    : null;
  // The functional CI test forces SwiftShader past production's fallback.
  // Keep overview downloads pending while checking the three label levels;
  // software mipmap generation for an entire overview is not a GPU benchmark.
  // The real-backend acceptance test measures unrestricted portrait loading.
  let releaseOverviewPortraits: (() => void) | undefined;
  let portraitGate: Promise<void> | null =
    testInfo.project.name === "desktop" && !process.env.DREVO_RENDER_PROFILE
      ? new Promise<void>((resolve) => { releaseOverviewPortraits = resolve; })
      : null;
  let portraitResponses = 0;
  await page.route("**/media/gpu-*.jpg?variant=*", async (route) => {
    await portraitGate;
    const url = new URL(route.request().url());
    const photo = portraits?.get(
      `${url.pathname.match(/gpu-(.+)\.jpg/)![1]}-${url.searchParams.get("variant")}`,
    );
    await route.fulfill(
      photo
        ? {
            contentType: "image/jpeg",
            body: photo,
            headers: { "Cache-Control": "public, max-age=3600" },
          }
        : {
            contentType: "image/svg+xml",
            body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#688a70"/></svg>',
          },
    );
    portraitResponses++;
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toBeVisible({ timeout: 15_000 });
  const tree = page.locator('.tree-canvas[data-renderer="webgl2"]');
  await expect(tree).toBeVisible({ timeout: 210_000 });
  const canvas = tree.locator(".tree-gpu-scene");
  const verifyContextLoss = async () => {
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { __gpuLayout: { requests: number } })
            .__gpuLayout.requests,
      ),
    ).toBe(requests);
    await canvas.evaluate((element: HTMLCanvasElement) =>
      element
        .getContext("webgl2")!
        .getExtension("WEBGL_lose_context")!
        .loseContext(),
    );
    await expect(
      page.locator('.tree-canvas[data-renderer="react-flow"]'),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page.locator(".tree-gpu-scene")).toHaveCount(0);
    await expect(page.locator(".flow-person-content").first()).toBeVisible();
  };
  await expect(canvas).toHaveAttribute("data-gpu-draws", /\d+/);
  stage("overview ready");
  expect(
    Number(await canvas.getAttribute("data-gpu-texture-bytes")),
  ).toBeLessThanOrEqual(38 * 1024 * 1024);
  expect(
    Number(await canvas.getAttribute("data-gpu-buffer-bytes")),
  ).toBeLessThan(24 * 1024 * 1024);
  expect(
    Number(await canvas.getAttribute("data-gpu-label-cpu-bytes")),
  ).toBeGreaterThan(Number(await canvas.getAttribute("data-gpu-label-bytes")));
  const verifyLabelBudget = async (lod: number) => {
    await expect(canvas).toHaveAttribute("data-gpu-label-lod", String(lod));
    const labels = Number(await canvas.getAttribute("data-gpu-label-bytes"));
    expect(labels).toBeGreaterThan(0);
    expect(
      Number(await canvas.getAttribute("data-gpu-label-cpu-bytes")),
    ).toBeGreaterThan(labels);
    expect(
      Number(await canvas.getAttribute("data-gpu-buffer-bytes")),
    ).toBeLessThan(24 * 1024 * 1024);
  };
  const requests = await page.evaluate(
    () =>
      (window as typeof window & { __gpuLayout: { requests: number } })
        .__gpuLayout.requests,
  );
  if (process.env.DREVO_RENDER_PROFILE && testInfo.project.name === "desktop")
    await profileTreeRenderer(page, testInfo);
  const zoom = () =>
    page
      .locator(".react-flow__viewport")
      .evaluate(
        (element) => new DOMMatrix(getComputedStyle(element).transform).a,
      );
  if (testInfo.project.name === "desktop") {
    // Optional profiling finishes at a close zoom; return to the name-only
    // level before checking that LOD uploads fit the same geometry budget.
    for (let i = 0; i < 16 && (await zoom()) > 0.4; i++)
      await page
        .getByRole("button", { name: "Уменьшить", exact: true })
        .click();
    for (let i = 0; i < 16 && (await zoom()) < 0.3; i++)
      await page
        .getByRole("button", { name: "Увеличить", exact: true })
        .click();
    expect(await zoom()).toBeGreaterThan(0.18);
    expect(await zoom()).toBeLessThan(0.52);
    await verifyLabelBudget(1);
    stage("labels LOD 1");
    await expect(tree).toBeVisible();
    expect(await page.locator(".react-flow__node-person").count()).toBeLessThan(
      25,
    );
    expect(await page.locator(".react-flow__edge").count()).toBe(0);
  }
  if (testInfo.project.name === "mobile") {
    const target = await page.evaluate(() => {
      const state = (
        window as typeof window & {
          __gpuLayout: {
            positions: [string, { x: number; y: number }][];
            width: number;
            occurrences: { id: string; personId: string }[];
          };
        }
      ).__gpuLayout;
      const matrix = new DOMMatrix(
        getComputedStyle(document.querySelector(".react-flow__viewport")!)
          .transform,
      );
      const root = document
        .querySelector(".tree-canvas")!
        .getBoundingClientRect();
      const box = document
        .querySelector(".react-flow")!
        .getBoundingClientRect();
      const clip = {
        left: Math.max(0, root.left, box.left),
        right: Math.min(innerWidth, root.right, box.right),
        top: Math.max(0, root.top, box.top),
        bottom: Math.min(innerHeight, root.bottom, box.bottom),
      };
      const people = new Map(
        state.occurrences.map((occurrence) => [
          occurrence.id,
          occurrence.personId,
        ]),
      );
      const centers = state.positions.map(([id, position]) => ({
        id: people.get(id),
        x: box.x + matrix.e + (position.x + state.width / 2) * matrix.a,
        y: box.y + matrix.f + (position.y + 70) * matrix.a,
      }));
      // Toolbar and camera controls occupy different areas on each screen.
      // Require an actual uncovered portrait rather than fixed page margins.
      const candidates = centers.filter(
        (point) =>
          point.id &&
          point.x > clip.left + 8 &&
          point.x < clip.right - 8 &&
          point.y > clip.top + 8 &&
          point.y < clip.bottom - 8 &&
          document
            .elementFromPoint(point.x, point.y)
            ?.closest(".react-flow__pane") &&
          !document
            .elementFromPoint(point.x, point.y)
            ?.closest("button, a, input, select, textarea"),
      );
      const cx = (clip.left + clip.right) / 2,
        cy = (clip.top + clip.bottom) / 2;
      candidates.sort(
        (a, b) =>
          Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy),
      );
      return {
        point: candidates[0] || null,
        nextPoint: candidates.find((point) => point.id !== candidates[0]?.id) || null,
        diagnostics: {
          positions: state.positions.length,
          occurrences: state.occurrences.length,
          width: state.width,
          viewport: { x: matrix.e, y: matrix.f, zoom: matrix.a },
          root: root.toJSON(),
          flow: box.toJSON(),
          clip,
          inside: centers.filter(
            (point) =>
              point.x > clip.left &&
              point.x < clip.right &&
              point.y > clip.top &&
              point.y < clip.bottom,
          ).length,
          uncovered: candidates.length,
          centerBounds: centers.length
            ? {
                left: Math.min(...centers.map((point) => point.x)),
                right: Math.max(...centers.map((point) => point.x)),
                top: Math.min(...centers.map((point) => point.y)),
                bottom: Math.max(...centers.map((point) => point.y)),
              }
            : null,
          centers: centers.slice(0, 8),
        },
      };
    });
    if (!target.point)
      await testInfo.attach("gpu-mobile-target", {
        body: JSON.stringify(target.diagnostics, null, 2),
        contentType: "application/json",
      });
    expect(target.point, JSON.stringify(target.diagnostics)).toBeTruthy();
    const point = target.point!;
    const pane = page.locator(".react-flow__pane");
    const pointer = {
      pointerId: 99,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: point.x,
      clientY: point.y,
      bubbles: true,
    };
    await pane.dispatchEvent("pointerdown", pointer);
    await expect(
      page.locator(`.flow-person[data-person-id="${point.id}"].is-selected`),
    ).toBeVisible();
    await pane.dispatchEvent("pointerup", pointer);
    await pane.dispatchEvent("click", { clientX: point.x, clientY: point.y });
    await expect(
      page.locator(`.flow-person[data-person-id="${point.id}"].is-selected`),
    ).toBeVisible();
    // A pinch can cancel the compatibility click after the long press fires.
    // Its stale suppression must not eat the first subsequent toolbar click.
    expect(target.nextPoint, JSON.stringify(target.diagnostics)).toBeTruthy();
    const next = target.nextPoint!;
    const held = { ...pointer, pointerId: 100, clientX: next.x, clientY: next.y };
    await pane.dispatchEvent("pointerdown", held);
    await expect(
      page.locator(`.flow-person[data-person-id="${next.id}"].is-selected`),
    ).toBeVisible();
    const second = { ...held, pointerId: 101, isPrimary: false };
    await pane.dispatchEvent("pointerdown", second);
    await pane.dispatchEvent("pointermove", { ...held, clientX: next.x + 24 });
    await pane.dispatchEvent("pointercancel", held);
    await pane.dispatchEvent("pointercancel", second);
    await page.getByRole("button", { name: "Настройки древа", exact: true }).click();
    const preferences = page.getByRole("dialog", { name: "Вид древа" });
    await expect(preferences).toBeVisible();
    await preferences.getByRole("button", { name: "Закрыть", exact: true }).click();
    // A second finger before the deadline cancels the pending selection too.
    const pending = { ...pointer, pointerId: 102 };
    await pane.dispatchEvent("pointerdown", pending);
    await pane.dispatchEvent("pointerdown", { ...pending, pointerId: 103, isPrimary: false });
    await page.evaluate(() => new Promise<void>((resolve) => setTimeout(resolve, 650)));
    await expect(
      page.locator(`.flow-person[data-person-id="${point.id}"].is-selected`),
    ).toHaveCount(0);
    await expect(
      page.locator(`.flow-person[data-person-id="${next.id}"].is-selected`),
    ).toBeVisible();
    await pane.dispatchEvent("pointercancel", pending);
  }
  await tree.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator(".tree-gpu-node-overlay .flow-person-content:focus"),
  ).toHaveCount(1);
  await expect.poll(zoom).toBeGreaterThanOrEqual(0.52);
  await verifyLabelBudget(2);
  stage("focused labels LOD 2");
  if (releaseOverviewPortraits) {
    expect(portraitResponses).toBe(0);
    const draws = Number(await canvas.getAttribute("data-gpu-draws"));
    releaseOverviewPortraits();
    portraitGate = null;
    await expect.poll(() => portraitResponses).toBeGreaterThan(0);
    await expect.poll(() => page.evaluate(() =>
      (window as typeof window & { __gpuPortraitUploads: { count: number } })
        .__gpuPortraitUploads.count,
    )).toBeGreaterThan(0);
    await page.evaluate(() => new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    ));
    // Loaded tiles must cause another real draw before inspecting the picture.
    await expect.poll(async () => Number(await canvas.getAttribute("data-gpu-draws")))
      .toBeGreaterThan(draws);
    stage("portrait uploaded and drawn");
  }
  const button = page.locator(
    ".tree-gpu-node-overlay .flow-person-content:focus",
  );
  const personId = await button.locator("..").getAttribute("data-person-id");
  expect(personId).toBeTruthy();
  const card = page.locator(`.flow-person[data-person-id="${personId}"]`);
  await expect(card.locator(".flow-privacy")).toBeVisible();
  const screenshot = await page.screenshot({
    path: testInfo.outputPath("gpu-tree.png"),
  });
  const pixels = await sharp(screenshot).removeAlpha().raw().toBuffer();
  let orange = 0;
  for (let i = 0; i < pixels.length; i += 3)
    if (
      pixels[i] > 180 &&
      pixels[i + 1] > 75 &&
      pixels[i + 1] < 170 &&
      pixels[i + 2] < 80
    )
      orange++;
  expect(orange).toBeGreaterThan(50);
  if (testInfo.project.name === "desktop") {
    await page.keyboard.press("Shift+Enter");
    await expect(card).toHaveClass(/is-selected/);
    // Entering the selected handle must keep its React Flow node stable: a
    // replacement briefly drops measured handle bounds and loses a fast drag.
    // Dragging a connection temporarily unmounts the GPU scene. Cancelling it
    // keeps the geometry, but the new canvas still needs its own ready handoff.
    // Hold portrait responses to make stale readiness observable on frame one.
    let releasePortraits!: () => void;
    portraitGate = new Promise<void>((resolve) => {
      releasePortraits = resolve;
    });
    const root = page.locator(".tree-canvas");
    const cameraBefore = await page
      .locator(".react-flow__viewport")
      .getAttribute("style");
    let handoffStartedAt = 0;
    try {
      const handle = card.locator('.react-flow__handle[data-handleid="right"]');
      const box = await handle.boundingBox();
      expect(box).toBeTruthy();
      const x = box!.x + box!.width / 2,
        y = box!.y + box!.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      // React Flow starts a connection only after its drag threshold, not on
      // mousedown. Cross that threshold before checking the native controls.
      await page.mouse.move(x + 18, y + 18, { steps: 2 });
      if ((await root.getAttribute("data-renderer")) !== "react-flow")
        await page.mouse.move(x + 54, y + 54, { steps: 3 });
      await expect(root).toHaveAttribute("data-renderer", "react-flow");
      await expect(page.locator(".tree-gpu-scene")).toHaveCount(0);
      // Use the committed native control, whose box can differ from the GPU
      // overlay. Releasing at stale coordinates can click the card underneath.
      const nativeBox = await handle.boundingBox();
      expect(nativeBox).toBeTruthy();
      await page.mouse.move(
        nativeBox!.x + nativeBox!.width / 2,
        nativeBox!.y + nativeBox!.height / 2,
        { steps: 2 },
      );
      await page.evaluate(() => {
        const state = { rendererOnFirstFrame: "" };
        Object.assign(window, { __gpuHandoff: state });
        const observer = new MutationObserver(() => {
          const next =
            document.querySelector<HTMLCanvasElement>(".tree-gpu-scene");
          if (!next?.dataset.gpuDraws) return;
          state.rendererOnFirstFrame = document
            .querySelector(".tree-canvas")!
            .getAttribute("data-renderer")!;
          observer.disconnect();
        });
        observer.observe(document, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: ["data-gpu-draws"],
        });
      });
      handoffStartedAt = Date.now();
      await page.mouse.up();
      await page.waitForFunction(
        () =>
          (
            window as typeof window & {
              __gpuHandoff: { rendererOnFirstFrame: string };
            }
          ).__gpuHandoff.rendererOnFirstFrame,
      );
      expect(
        await page.evaluate(
          () =>
            (
              window as typeof window & {
                __gpuHandoff: { rendererOnFirstFrame: string };
              }
            ).__gpuHandoff.rendererOnFirstFrame,
        ),
      ).toBe("react-flow");
      await expect(page.locator(".react-flow__viewport")).toHaveAttribute(
        "style",
        cameraBefore!,
      );
      // Keep downloads held while the bounded handoff deadline expires. This
      // verifies recovery independently of software GL's mipmap upload speed.
      await expect
        .poll(
          async () => ({
            renderer: await root.getAttribute("data-renderer"),
            fallback: await root.getAttribute("data-gpu-fallback"),
            canvasCount: await canvas.count(),
            readyCalled: await canvas.getAttribute("data-gpu-ready-called"),
            sceneMatch: await root.getAttribute("data-gpu-scene-match"),
          }),
          { timeout: 15_000 },
        )
        .toEqual({
          renderer: "webgl2",
          fallback: null,
          canvasCount: 1,
          readyCalled: "true",
          sceneMatch: "true",
        });
      await expect(tree).toBeVisible({ timeout: 15_000 });
      console.log(
        "GPU handoff recovered while portraits held",
        Date.now() - handoffStartedAt,
      );
      await expect(canvas).toHaveAttribute("data-gpu-draws", /\d+/);
      const resourcesBeforeSelection = await page.evaluate(
        () =>
          (
            window as typeof window & {
              __gpuResources: { programs: number; glyphUploads: number };
            }
          ).__gpuResources,
      );
      expect(resourcesBeforeSelection.programs).toBeGreaterThan(0);
      expect(resourcesBeforeSelection.glyphUploads).toBeGreaterThan(0);
      await card.locator(".flow-person-content").focus();
      await page.keyboard.press("Shift+Enter");
      await expect(card).not.toHaveClass(/is-selected/);
      // Let the resulting scene update and two paints finish before comparing.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(
        await page.evaluate(
          () =>
            (
              window as typeof window & {
                __gpuResources: { programs: number; glyphUploads: number };
              }
            ).__gpuResources,
        ),
      ).toEqual(resourcesBeforeSelection);
      // Additive selection keeps comparison mode active even after its last
      // person is removed. Exit through the UI before testing an ordinary click.
      await page
        .getByRole("button", { name: "Закрыть панель", exact: true })
        .click();
      await expect(page.locator(".inspector-dock")).toHaveCount(0);
      await expect(tree).toBeVisible();
      // Changing the profile route within this archive must retain its GPU
      // context and glyph atlas, including the inspector width change.
      await card.locator(".flow-person-content").click();
      await expect(page).toHaveURL(new RegExp("/people/" + personId + "$"));
      await expect(page.locator(".inspector-dock")).toBeVisible();
      await expect(tree).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (
              window as typeof window & {
                __gpuResources: { programs: number; glyphUploads: number };
              }
            ).__gpuResources,
        ),
      ).toEqual(resourcesBeforeSelection);
      await page
        .getByRole("button", { name: "Закрыть панель", exact: true })
        .click();
      await expect(tree).toBeVisible();
      expect(
        await page.evaluate(
          () =>
            (
              window as typeof window & {
                __gpuResources: { programs: number; glyphUploads: number };
              }
            ).__gpuResources,
        ),
      ).toEqual(resourcesBeforeSelection);
      await verifyContextLoss();
    } catch (error) {
      const diagnostics = await root.evaluate((element) => ({
        url: location.href,
        renderer: element.getAttribute("data-renderer"),
        sceneMatch: element.getAttribute("data-gpu-scene-match"),
        fallback: element.getAttribute("data-gpu-fallback"),
        className: element.className,
        personOverlays: element.querySelectorAll(".flow-person").length,
        layoutRequests: (
          window as typeof window & { __gpuLayout: { requests: number } }
        ).__gpuLayout.requests,
        canvas: [...element.querySelectorAll<HTMLCanvasElement>("canvas")].map(
          (item) => ({
            className: item.className,
            width: item.width,
            height: item.height,
            visibility: item.style.visibility,
            data: { ...item.dataset },
          }),
        ),
        connectionLine: element.querySelector(".react-flow__connection")
          ?.outerHTML,
        dialogs: [...document.querySelectorAll('[role="dialog"]')].map((item) =>
          item.getAttribute("aria-label"),
        ),
      }));
      console.log("GPU handoff failure", JSON.stringify(diagnostics));
      console.log(
        "GPU handoff elapsed after cancellation",
        Date.now() - handoffStartedAt,
      );
      await testInfo.attach("gpu-handoff-diagnostics", {
        body: JSON.stringify(diagnostics, null, 2),
        contentType: "application/json",
      });
      throw error;
    } finally {
      await page.mouse.up();
      portraitGate = null;
      releasePortraits();
    }
  } else {
    const bounds = await button.boundingBox();
    expect(bounds).toBeTruthy();
    await page.touchscreen.tap(bounds!.x + bounds!.width / 2, bounds!.y + 65);
    await expect(card).toHaveClass(/is-selected/);
  }
  if (testInfo.project.name !== "desktop") await verifyContextLoss();
});

test("shared GPU tree keeps review rings and releases its scene when access is revoked", async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== "desktop");
  test.setTimeout(180_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const get = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (
      parameter: number,
    ) {
      return parameter === 37446
        ? "Drevo GPU integration test"
        : get.call(this, parameter);
    };
  });
  const token = "g".repeat(43);
  const original = await (await page.request.get("/api/family")).json();
  const family = {
    ...original.family,
    links: [],
    unions: [],
    photos: [],
    people: randomFamily(1, 6).map((person) => ({
      ...person,
      name: person.id,
      surname: "Тестов",
      patronymic: "",
      sex: "m",
      birthPlace: "",
      generation: 1,
      column: 0,
      sources: [],
      needsReview: true,
      photo: `/api/shared/${token}/portrait/${person.id}`,
    })),
  };
  let revoked = false;
  await page.route(`**/api/shared/${token}{,?check=1}`, (route) =>
    route.fulfill(
      revoked
        ? { status: 403, json: { error: "Ссылка отозвана" } }
        : {
            json: {
              family,
              expiresAt: new Date(Date.now() + 3600_000).toISOString(),
              serverTime: new Date().toISOString(),
            },
          },
    ),
  );
  await page.route(`**/api/shared/${token}/portrait/**`, (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#688a70"/></svg>',
    }),
  );
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (request.resourceType() === "image") mediaRequests.push(request.url());
  });
  await page.goto(`/s/${token}`);
  const tree = page.locator('.tree-canvas[data-renderer="webgl2"]');
  await expect(tree).toBeVisible({ timeout: 150_000 });
  await tree.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator(".tree-gpu-node-overlay .flow-person-content:focus"),
  ).toHaveCount(1);
  await expect(page.locator(".flow-privacy")).toHaveCount(0);
  const screenshot = await page.screenshot({
    path: testInfo.outputPath("shared-gpu-tree.png"),
  });
  const pixels = await sharp(screenshot).removeAlpha().raw().toBuffer();
  let orange = 0;
  for (let i = 0; i < pixels.length; i += 3)
    if (
      pixels[i] > 180 &&
      pixels[i + 1] > 75 &&
      pixels[i + 1] < 170 &&
      pixels[i + 2] < 80
    )
      orange++;
  expect(orange).toBeGreaterThan(50);
  const protectedImages = mediaRequests.filter((url) =>
    /\/(?:media|portrait)\//.test(new URL(url).pathname),
  );
  expect(protectedImages.length).toBeGreaterThan(0);
  expect(
    protectedImages.every((url) =>
      new URL(url).pathname.startsWith(`/api/shared/${token}/portrait/`),
    ),
  ).toBe(true);
  revoked = true;
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(
    page.getByText("Ссылка отозвана", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".tree-gpu-scene")).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).toHaveCount(0);
});
