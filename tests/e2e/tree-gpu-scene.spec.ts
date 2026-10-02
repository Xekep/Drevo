import { expect, test } from "@playwright/test";
import { randomFamily } from "../layout-fixtures";
import { profileTreeRenderer } from "./tree-render-profile";
import sharp from "sharp";
import { renderPortraits } from "./render-portraits";

test.use({
  trace: "off",
  launchOptions: {
    args: ["--enable-unsafe-swiftshader"],
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {}),
  },
});
test("large GPU tree keeps one camera, sparse controls and a working context-loss fallback", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const people =
    process.env.DREVO_GPU_PEOPLE === "977"
      ? randomFamily(5, 9)
      : randomFamily(1, 6);
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
  await page.route("**/media/gpu-*.jpg?variant=*", (route) => {
    const url = new URL(route.request().url());
    const photo = portraits?.get(
      `${url.pathname.match(/gpu-(.+)\.jpg/)![1]}-${url.searchParams.get("variant")}`,
    );
    return route.fulfill(
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
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toBeVisible();
  const tree = page.locator('.tree-canvas[data-renderer="webgl2"]');
  await expect(tree).toBeVisible({ timeout: 210_000 });
  const canvas = tree.locator(".tree-gpu-scene");
  await expect(canvas).toHaveAttribute("data-gpu-draws", /\d+/);
  expect(
    Number(await canvas.getAttribute("data-gpu-texture-bytes")),
  ).toBeLessThanOrEqual(38 * 1024 * 1024);
  expect(
    Number(await canvas.getAttribute("data-gpu-buffer-bytes")),
  ).toBeLessThan(24 * 1024 * 1024);
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
    for (let i = 0; i < 16 && (await zoom()) < 0.3; i++)
      await page
        .getByRole("button", { name: "Увеличить", exact: true })
        .click();
    expect(await zoom()).toBeGreaterThan(0.18);
    await expect(tree).toBeVisible();
    expect(await page.locator(".react-flow__node-person").count()).toBeLessThan(
      25,
    );
    expect(await page.locator(".react-flow__edge").count()).toBe(0);
  }
  if (testInfo.project.name === "mobile") {
    const point = await page.evaluate(() => {
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
      const box = document
        .querySelector(".react-flow")!
        .getBoundingClientRect();
      return state.positions
        .map(([id, position]) => ({
          id: state.occurrences.find((occurrence) => occurrence.id === id)!
            .personId,
          x: box.x + matrix.e + (position.x + state.width / 2) * matrix.a,
          y: box.y + matrix.f + (position.y + 70) * matrix.a,
        }))
        .find(
          (point) =>
            point.x > 60 &&
            point.x < innerWidth - 60 &&
            point.y > 160 &&
            point.y < innerHeight - 140,
        );
    });
    expect(point).toBeTruthy();
    const pane = page.locator(".react-flow__pane");
    const pointer = {
      pointerId: 99,
      pointerType: "touch",
      isPrimary: true,
      button: 0,
      clientX: point!.x,
      clientY: point!.y,
      bubbles: true,
    };
    await pane.dispatchEvent("pointerdown", pointer);
    await expect(
      page.locator(`.flow-person[data-person-id="${point!.id}"].is-selected`),
    ).toBeVisible();
    await pane.dispatchEvent("pointerup", pointer);
    await pane.dispatchEvent("click", { clientX: point!.x, clientY: point!.y });
    await expect(
      page.locator(`.flow-person[data-person-id="${point!.id}"].is-selected`),
    ).toBeVisible();
  }
  await tree.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator(".tree-gpu-node-overlay .flow-person-content:focus"),
  ).toHaveCount(1);
  await expect.poll(zoom).toBeGreaterThanOrEqual(0.52);
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
  } else {
    const bounds = await button.boundingBox();
    expect(bounds).toBeTruthy();
    await page.touchscreen.tap(bounds!.x + bounds!.width / 2, bounds!.y + 65);
    await expect(card).toHaveClass(/is-selected/);
  }
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
  ).toBeVisible();
  await expect(page.locator(".tree-gpu-scene")).toHaveCount(0);
  await expect(page.locator(".flow-person-content").first()).toBeVisible();
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
