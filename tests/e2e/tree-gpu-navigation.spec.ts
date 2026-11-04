import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";
import { randomFamily } from "../layout-fixtures";
import { familyViewAction } from "./tree-toolbar-actions";
import { DEFAULT_TREE_PREFERENCES } from "../../src/domain/tree-preferences";

type Frame = {
  time: number;
  width: number;
  height: number;
  drawnWidth: number;
  drawnHeight: number;
  viewport: string;
  renderer: string | null;
  nodes: number;
  progress: number;
  programs: number;
};
type Probe = {
  width: number;
  height: number;
  programs: number;
  livePrograms: number;
  maximumPrograms: number;
  record: boolean;
  frames: Frame[];
  positions: [string, { x: number; y: number }][];
};
declare global {
  interface Window {
    __gpuNavigation: Probe;
  }
}

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-swiftshader",
      ...(process.env.DREVO_GPU_SOFTWARE === "1"
        ? ["--use-angle=swiftshader"]
        : process.env.DREVO_E2E_ANGLE
          ? [`--use-angle=${process.env.DREVO_E2E_ANGLE}`]
          : []),
    ],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  },
});

async function setup(page: Page, reduced = false) {
  await page.setViewportSize({ width: 2560, height: 1440 });
  await page.emulateMedia({
    reducedMotion: reduced ? "reduce" : "no-preference",
  });
  await page.addInitScript(() => {
    const state: Probe = {
      width: 0,
      height: 0,
      programs: 0,
      livePrograms: 0,
      maximumPrograms: 0,
      record: false,
      frames: [],
      positions: [],
    };
    window.__gpuNavigation = state;
    const proto = WebGL2RenderingContext.prototype,
      names = new WeakMap<WebGLUniformLocation, string>();
    const get = proto.getParameter;
    // Exercise the same renderer in software CI. Timing is reported separately
    // from functional assertions and is not a hardware performance claim.
    proto.getParameter = function (p) {
      return p === 37446 ? "GPU navigation test" : get.call(this, p);
    };
    const uniform = proto.getUniformLocation;
    proto.getUniformLocation = function (p, n) {
      const loc = uniform.call(this, p, n);
      if (loc) names.set(loc, n);
      return loc;
    };
    const size = proto.uniform2f;
    proto.uniform2f = function (l, x, y) {
      if (l && names.get(l) === "viewport") {
        state.width = x;
        state.height = y;
      }
      return size.call(this, l, x, y);
    };
    const create = proto.createProgram,
      remove = proto.deleteProgram;
    proto.createProgram = function () {
      state.programs++;
      state.livePrograms++;
      state.maximumPrograms = Math.max(
        state.maximumPrograms,
        state.livePrograms,
      );
      return create.call(this);
    };
    proto.deleteProgram = function (p) {
      if (p) state.livePrograms--;
      return remove.call(this, p);
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (event.data?.geometry?.positions)
            state.positions = event.data.geometry.positions;
        });
      }
    };
    const tick = (time: number) => {
      if (state.record) {
        const root = document.querySelector(".tree-canvas"),
          canvas = root?.querySelector<HTMLCanvasElement>(".tree-gpu-scene");
        const viewport = root?.querySelector(".react-flow__viewport"),
          box = canvas?.getBoundingClientRect();
        state.frames.push({
          time,
          width: box?.width || 0,
          height: box?.height || 0,
          drawnWidth: state.width,
          drawnHeight: state.height,
          viewport: viewport ? getComputedStyle(viewport).transform : "",
          renderer: root?.getAttribute("data-renderer") || null,
          nodes: root?.querySelectorAll(".react-flow__node").length || 0,
          progress: Number(canvas?.dataset.gpuTransitionProgress ?? 1),
          programs: state.programs,
        });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const people = randomFamily(1, 6).slice(0, 269),
    ids = new Set(people.map((p) => p.id));
  let preferences = {
    ...DEFAULT_TREE_PREFERENCES,
    fragmentThreshold: 0,
    animateOnLoad: false,
  };
  await page.route("**/api/tree-preferences", async (route) => {
    if (route.request().method() === "PUT")
      preferences = route.request().postDataJSON();
    await route.fulfill({ json: preferences });
  });
  const portrait = await sharp({
    create: { width: 64, height: 64, channels: 3, background: "#367449" },
  })
    .png()
    .toBuffer();
  await page.route("**/media/navigation-*.png*", (route) =>
    route.fulfill({ contentType: "image/png", body: portrait }),
  );
  await page.route("**/api/admin/published-people/batch?*", (route) =>
    route.fulfill({
      json: { fields: Object.fromEntries(people.map((p) => [p.id, {}])) },
    }),
  );
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.family = {
      ...data.family,
      people: people.map((p, i) => ({
        ...p,
        name: `Тест ${i}`,
        surname: "Проверка",
        patronymic: "",
        sex: "m",
        birthPlace: "",
        photo: i % 3 === 0 ? `/media/navigation-${i}.png` : undefined,
        parents: p.parents.filter((id) => ids.has(id)),
        spouses: p.spouses.filter((id) => ids.has(id)),
        sources: [],
        generation: 1,
        column: 0,
      })),
      links: [],
      unions: [],
      photos: [],
    };
    data.partial = false;
    data.user.personId = null;
    data.treePreferences = preferences;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const root = page.locator(".tree-canvas");
  await expect(root).toHaveAttribute("data-renderer", "webgl2", {
    timeout: 90_000,
  });
  await page
    .getByRole("combobox", { name: "Найти человека или документ" })
    .fill("Тест 0");
  await page.getByRole("option").first().click();
  await expect(root).not.toHaveClass(/is-layout-settling|is-growing/);
  await expect(page.locator(".tree-gpu-scene")).toHaveAttribute(
    "data-gpu-transition-progress",
    "1",
  );
  await page.waitForTimeout(reduced ? 100 : 800);
  return page.locator('.flow-person[data-person-id="f-0"]').first();
}

async function record(page: Page) {
  await page.evaluate(() => {
    window.__gpuNavigation.frames = [];
    window.__gpuNavigation.record = true;
  });
}
async function finish(page: Page, label: string) {
  const frames = await page.evaluate(() => {
    window.__gpuNavigation.record = false;
    return window.__gpuNavigation.frames;
  });
  await test.info().attach(label, {
    body: JSON.stringify(frames),
    contentType: "application/json",
  });
  expect(frames.length).toBeGreaterThan(3);
  expect(frames.every((f) => f.renderer === "webgl2")).toBe(true);
  expect(Math.max(...frames.map((f) => f.nodes))).toBeLessThan(25);
  expect(
    frames.every(
      (f) =>
        Math.abs(f.width - f.drawnWidth) < 1 &&
        Math.abs(f.height - f.drawnHeight) < 1,
    ),
  ).toBe(true);
  return frames;
}
async function point(page: Page, id = "f-0") {
  const overlay = page
    .locator(`.flow-person[data-person-id="${id}"] .flow-person-content`)
    .first();
  if (await overlay.count()) {
    const box = (await overlay.boundingBox())!;
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }
  return page.evaluate((id) => {
    const p = window.__gpuNavigation.positions.find(([key]) => key === id)![1];
    const v = new DOMMatrix(
      getComputedStyle(document.querySelector(".react-flow__viewport")!)
        .transform,
    );
    const b = document.querySelector(".react-flow")!.getBoundingClientRect();
    return {
      x: b.x + (p.x + 110) * v.a + v.e,
      y: b.y + (p.y + 70) * v.a + v.f,
    };
  }, id);
}

test("GPU privacy control is painted above the portrait", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop stacking regression");
  test.setTimeout(120_000);
  const card = await setup(page, true),
    eye = card.locator(".flow-privacy");
  await card.hover();
  await expect(eye).toHaveAttribute("data-publication-state", "published");
  await expect(eye).toHaveCSS("opacity", "1");
  const box = (await eye.boundingBox())!;
  const before = await page.screenshot({ clip: box });
  await page.locator(".tree-gpu-scene").evaluate((el) => {
    (el as HTMLElement).style.visibility = "hidden";
  });
  const after = await page.screenshot({ clip: box });
  const b = await sharp(after).removeAlpha().raw().toBuffer();
  const coveredPixels = async (screenshot: Buffer) => {
    const a = await sharp(screenshot)
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let differences = 0;
    for (let y = 0; y < a.info.height; y++)
      for (let x = 0; x < a.info.width; x++) {
        if (Math.hypot(x / a.info.width - 0.5, y / a.info.height - 0.5) > 0.38)
          continue;
        const i = (y * a.info.width + x) * a.info.channels;
        if ([0, 1, 2].some((c) => Math.abs(a.data[i + c] - b[i + c]) > 2))
          differences++;
      }
    return differences;
  };
  await test.info().attach("privacy-over-portrait", {
    body: before,
    contentType: "image/png",
  });
  expect(
    await coveredPixels(before),
    "opaque control pixels must not be covered by the portrait",
    // Fractional screenshot clipping/compositing differs by one pixel in Linux.
  ).toBeLessThanOrEqual(2);
  await test
    .info()
    .attach("privacy-without-gpu", { body: after, contentType: "image/png" });
  // Negative control: the tolerance must still detect the original stacking bug.
  await page.locator(".tree-gpu-scene").evaluate((el) => {
    (el as HTMLElement).style.visibility = "visible";
  });
  await page.locator(".tree-canvas .react-flow").evaluate((el) => {
    (el as HTMLElement).style.setProperty("z-index", "0", "important");
  });
  const obscured = await page.screenshot({ clip: box });
  await test
    .info()
    .attach("privacy-original-stacking", {
      body: obscured,
      contentType: "image/png",
    });
  expect(
    await coveredPixels(obscured),
    "original stacking must visibly obscure the control",
  ).toBeGreaterThan(10);
});

test("opening and closing a person keeps the GPU bitmap and camera steady", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop inspector resizes the canvas");
  test.setTimeout(120_000);
  await setup(page);
  await page
    .getByRole("button", { name: "Закрыть панель", exact: true })
    .click();
  await page.waitForTimeout(800);
  const original = await page.locator(".tree-gpu-scene").elementHandle();
  for (let i = 0; i < 2; i++) {
    const p = await point(page);
    await page.mouse.move(p.x, p.y);
    await record(page);
    await page.mouse.click(p.x, p.y);
    const close = page.getByRole("button", {
      name: "Закрыть панель",
      exact: true,
    });
    await expect(close).toBeVisible();
    await page.waitForTimeout(800);
    await close.click();
    await expect(close).not.toBeVisible();
    await page.waitForTimeout(800);
    const frames = await finish(page, `inspector-${i}`);
    expect(new Set(frames.map((f) => f.viewport)).size).toBe(1);
    expect(frames.at(-1)!.programs).toBe(frames[0].programs);
    expect(await original!.evaluate((el) => el.isConnected)).toBe(true);
  }
});

for (const reduced of [false, true])
  test(`GPU scopes retain the canvas and finish transitions${reduced ? " with reduced motion" : ""}`, async ({
    page,
    isMobile,
  }) => {
    test.skip(isMobile, "QHD desktop navigation regression");
    test.setTimeout(180_000);
    await setup(page, reduced);
    const canvas = page.locator(".tree-gpu-scene"),
      original = await canvas.elementHandle();
    for (const name of ["Кровные", "Всё древо", "Близкие", "Всё древо"]) {
      await record(page);
      await familyViewAction(page, name);
      await expect(page.locator(".tree-canvas")).toHaveAttribute(
        "data-layout-ready",
        "true",
      );
      await page.waitForTimeout(reduced ? 300 : 1000);
      await expect(canvas).toHaveAttribute("data-gpu-transition-progress", "1");
      const frames = await finish(page, name);
      expect(frames.some((f) => f.progress > 0 && f.progress < 1)).toBe(
        !reduced,
      );
      expect(await original!.evaluate((el) => el.isConnected)).toBe(true);
      expect(
        await page.evaluate(() => window.__gpuNavigation.livePrograms),
      ).toBe(2);
      expect(
        await page.evaluate(() => window.__gpuNavigation.maximumPrograms),
      ).toBeLessThanOrEqual(4);
    }
    const p = await point(page);
    await record(page);
    await page.mouse.click(p.x, p.y, { button: "middle" });
    await expect(
      page.getByRole("status", { name: "Опорный человек", exact: true }),
    ).toBeVisible();
    await page.waitForTimeout(1000);
    await finish(page, "anchor");
    await record(page);
    await page
      .getByRole("button", { name: "Снять ограничения поколений", exact: true })
      .click();
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-people",
      "269",
    );
    await page.waitForTimeout(1000);
    await finish(page, "reset-anchor");
    expect(await original!.evaluate((el) => el.isConnected)).toBe(true);
    if (!reduced) {
      await record(page);
      for (let i = 0; i < 2; i++) {
        await familyViewAction(page, "Кровные");
        await expect(page.locator(".tree-canvas")).toHaveAttribute(
          "data-layout-people",
          "177",
        );
        await familyViewAction(page, "Всё древо");
        await expect(page.locator(".tree-canvas")).toHaveAttribute(
          "data-layout-people",
          "269",
        );
      }
      await page.waitForTimeout(800);
      await finish(page, "interrupted-transitions");
      expect(
        await page.evaluate(() => window.__gpuNavigation.livePrograms),
      ).toBe(2);
      expect(
        await page.evaluate(() => window.__gpuNavigation.maximumPrograms),
      ).toBeLessThanOrEqual(4);
    }
  });
