import { expect, test, type Page } from "@playwright/test";
import sharp from "sharp";

test.use({
  launchOptions: {
    args: [
      "--enable-unsafe-swiftshader",
      ...(process.env.DREVO_GPU_SOFTWARE === "1"
        ? ["--use-angle=swiftshader"]
        : []),
    ],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  },
});

test("ordinary GPU portraits keep their silhouettes without photo, review or selection flags", async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    // CI executes the real shaders with SwiftShader; this is a pixel regression,
    // not a hardware performance claim. Production software detection stays on.
    const get = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (
      parameter: number,
    ) {
      return parameter === 37446
        ? "Drevo GPU integration test"
        : get.call(this, parameter);
    };
    const state = {
      positions: [] as [string, { x: number; y: number }][],
      width: 220,
    };
    Object.assign(window, { __cameoGpuLayout: state });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent) => {
          if (event.data?.geometry?.positions) {
            state.positions = event.data.geometry.positions;
            state.width = event.data.geometry.nodeSize.width;
          }
        });
      }
    };
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    const seed = data.family.people[0];
    data.family.people = Array.from({ length: 1000 }, (_, index) => ({
      ...seed,
      id: `gpu-cameo-${index}`,
      name: `Человек ${index}`,
      birth: "1900",
      parents: index % 12 ? [`gpu-cameo-${index - 1}`] : [],
      spouses: [],
      sources: [],
      photo: "",
      needsReview: false,
      sex: ["m", "f", "u"][index % 3],
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  const mediaRequests: string[] = [];
  page.on("request", (request) => {
    if (/\/(?:media|portrait)\//.test(new URL(request.url()).pathname))
      mediaRequests.push(request.url());
  });
  await page.goto("/tree");
  const root = page.locator('.tree-canvas[data-renderer="webgl2"]');
  await expect(root).toBeVisible({ timeout: 30_000 });
  await root.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const viewport = element.querySelector(".react-flow__viewport")!;
    const zoom = new DOMMatrix(getComputedStyle(viewport).transform).a;
    element.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        deltaY: -Math.log(0.12 / zoom) / 0.002,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      }),
    );
  });
  await expect
    .poll(() =>
      page
        .locator(".react-flow__viewport")
        .evaluate(
          (element) => new DOMMatrix(getComputedStyle(element).transform).a,
        ),
    )
    .toBeCloseTo(0.12, 4);
  await page.mouse.move(0, 0);
  await expect(page.locator(".flow-person.is-selected")).toHaveCount(0);
  await expect(page.locator(".flow-person.is-needs-review")).toHaveCount(0);
  await expect(page.locator(".tree-gpu-scene")).toHaveAttribute(
    "data-gpu-draws",
    /\d+/,
  );
  await expect.poll(() => visibleCameos(page)).toBeGreaterThan(8);
  await page.screenshot({
    path: testInfo.outputPath("gpu-ordinary-cameos.png"),
  });
  expect(mediaRequests).toEqual([]);
});

async function visibleCameos(page: Page) {
  const points = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __cameoGpuLayout: {
          positions: [string, { x: number; y: number }][];
          width: number;
        };
      }
    ).__cameoGpuLayout;
    const root = document.querySelector(".tree-canvas")!;
    const bounds = root.querySelector(".react-flow")!.getBoundingClientRect();
    const camera = new DOMMatrix(
      getComputedStyle(root.querySelector(".react-flow__viewport")!).transform,
    );
    return {
      screenWidth: innerWidth,
      screenHeight: innerHeight,
      points: state.positions
        .map(([, point]) => ({
          x: bounds.x + camera.e + (point.x + state.width / 2) * camera.a,
          y: bounds.y + camera.f + (point.y + 55) * camera.a,
          flank: 40 * camera.a,
        }))
        .filter(
          (p) =>
            p.x > bounds.left + 20 &&
            p.x < bounds.right - 20 &&
            p.y > bounds.top + 100 &&
            p.y < bounds.bottom - 50,
        ),
    };
  });
  const { data, info } = await sharp(await page.screenshot())
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const scaleX = info.width / points.screenWidth,
    scaleY = info.height / points.screenHeight;
  const red = (x: number, y: number) =>
    data[
      (Math.floor(y * scaleY) * info.width + Math.floor(x * scaleX)) *
        info.channels
    ];
  return points.points.filter(
    (point) => red(point.x + point.flank, point.y) - red(point.x, point.y) > 30,
  ).length;
}
