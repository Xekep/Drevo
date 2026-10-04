import { expect, test } from "@playwright/test";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences.ts";

test.use({
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

test("ready GPU survives pending native scope without manufacturing exiting cards or edges", async ({
  page,
  isMobile,
}) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.addInitScript(() => {
    const get = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function (
      parameter: number,
    ) {
      return parameter === 37446
        ? "Drevo GPU integration test"
        : get.call(this, parameter);
    };
    const state = {
      programs: 0,
      armed: false,
      held: 0,
      requests: [] as number[],
      originalCanvas: null as HTMLCanvasElement | null,
      originalContext: null as WebGL2RenderingContext | null,
      exits: 0,
      rendererLost: false,
      canvasLost: false,
      enters: false,
      queued: [] as (() => void)[],
      observing: false,
    };
    Object.assign(window, { __gpuHandoff: state });
    const create = WebGL2RenderingContext.prototype.createProgram;
    WebGL2RenderingContext.prototype.createProgram = function () {
      state.programs++;
      return create.call(this);
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      private smallRequest = false;
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        this.addEventListener("message", (event: MessageEvent) => {
          if (!state.armed || !this.smallRequest || !event.data?.geometry)
            return;
          event.stopImmediatePropagation();
          state.held++;
          state.queued.push(() =>
            this.dispatchEvent(
              new MessageEvent("message", { data: event.data }),
            ),
          );
        });
      }
      postMessage(
        message: unknown,
        transfer: Transferable[] | StructuredSerializeOptions = [],
      ) {
        if (
          message &&
          typeof message === "object" &&
          "people" in message &&
          Array.isArray(message.people)
        ) {
          const count = message.people.length;
          this.smallRequest = count === 64;
          state.requests.push(count);
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
    const check = () => {
      if (!state.observing) return;
      const root = document.querySelector(".tree-canvas");
      if (state.armed) {
        if (root?.getAttribute("data-renderer") !== "webgl2")
          state.rendererLost = true;
        if (root?.querySelector(".tree-gpu-scene") !== state.originalCanvas)
          state.canvasLost = true;
      }
      if (root?.querySelector(".tree-enter-node")) state.enters = true;
    };
    new MutationObserver((records) => {
      if (!state.observing) return;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          state.exits += Number(
            node.matches(".tree-exit-node, .tree-exit-edge"),
          );
          state.exits += node.querySelectorAll(
            ".tree-exit-node, .tree-exit-edge",
          ).length;
        }
        if (
          record.target instanceof Element &&
          record.target.matches(".tree-exit-node, .tree-exit-edge")
        )
          state.exits++;
      }
      check();
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "data-renderer"],
    });
  });
  let preferences: TreePreferences = { ...DEFAULT_TREE_PREFERENCES };
  await page.route("**/api/tree-preferences", async (route) => {
    if (route.request().method() === "PUT")
      preferences = route.request().postDataJSON();
    await route.fulfill({ json: preferences });
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.family.people = Array.from({ length: 600 }, (_, index) => ({
      id: `handoff-${index}`,
      name: `Человек ${index}`,
      surname: "Тестов",
      patronymic: "",
      sex: index === 1 ? "f" : "m",
      birth: "",
      birthPlace: "",
      parents: index >= 2 && index < 64 ? ["handoff-0", "handoff-1"] : [],
      spouses: index < 2 ? [`handoff-${1 - index}`] : [],
      generation: 1,
      column: 0,
      sources: [],
    }));
    data.family.links = [];
    data.family.unions = [];
    data.family.photos = [];
    data.treePreferences = preferences;
    data.partial = false;
    data.user.personId = null;
    await route.fulfill({ response, json: data });
  });
  await page.goto("/tree");
  const root = page.locator(".tree-canvas"),
    canvas = page.locator(".tree-gpu-scene");
  await expect(root).toHaveAttribute("data-renderer", "webgl2", {
    timeout: 90_000,
  });
  await expect(root).not.toHaveClass(/is-growing|is-layout-settling/);
  await expect(root).toHaveAttribute("data-layout-people", "600");
  await expect(canvas).toHaveAttribute("data-gpu-draws", /\d+/);
  const programs = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __gpuHandoff: {
          originalCanvas: HTMLCanvasElement | null;
          originalContext: WebGL2RenderingContext | null;
          programs: number;
          armed: boolean;
          observing: boolean;
        };
      }
    ).__gpuHandoff;
    state.originalCanvas =
      document.querySelector<HTMLCanvasElement>(".tree-gpu-scene");
    state.originalContext = state.originalCanvas!.getContext("webgl2");
    state.armed = true;
    state.observing = true;
    return state.programs;
  });
  await page.getByRole("button", { name: "Настройки древа" }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog
    .getByRole("switch", { name: "Ограничить видимое древо" })
    .check();
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            (window as typeof window & { __gpuHandoff: { held: number } })
              .__gpuHandoff.held,
        ),
      { timeout: 30_000 },
    )
    .toBe(1);
  expect(preferences.generationLimits?.anchorId).toBe("handoff-0");
  await expect(root).toHaveAttribute("data-layout-ready", "false");
  if (isMobile) await expect(root.locator(".tree-mode-switch")).toBeDisabled();
  else await expect(page.locator(".summary-busy")).toBeVisible();
  await expect(root).toHaveAttribute("data-renderer", "webgl2");
  const pending = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __gpuHandoff: {
          programs: number;
          originalCanvas: HTMLCanvasElement;
          originalContext: WebGL2RenderingContext;
          exits: number;
          rendererLost: boolean;
          canvasLost: boolean;
        };
      }
    ).__gpuHandoff;
    const element =
      document.querySelector<HTMLCanvasElement>(".tree-gpu-scene");
    return {
      programs: state.programs,
      exits: state.exits,
      rendererLost: state.rendererLost,
      canvasLost: state.canvasLost,
      sameCanvas: element === state.originalCanvas,
      sameContext: element?.getContext("webgl2") === state.originalContext,
    };
  });
  expect(pending).toEqual({
    programs,
    exits: 0,
    rendererLost: false,
    canvasLost: false,
    sameCanvas: true,
    sameContext: true,
  });
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __gpuHandoff: { armed: boolean; queued: (() => void)[] };
      }
    ).__gpuHandoff;
    state.armed = false;
    for (const release of state.queued.splice(0)) release();
  });
  await expect(root).toHaveAttribute("data-layout-ready", "true");
  await expect(root).toHaveAttribute("data-layout-people", "64");
  await expect(root).toHaveAttribute("data-renderer", "react-flow");
  await expect(root).not.toHaveClass(/is-layout-settling/);
  await expect(canvas).toHaveCount(0);
  await expect(page.locator(".tree-exit-node, .tree-exit-edge")).toHaveCount(0);
  const transition = await page.evaluate(() => {
    const state = (
      window as typeof window & {
        __gpuHandoff: { exits: number; enters: boolean };
      }
    ).__gpuHandoff;
    return { exits: state.exits, enters: state.enters };
  });
  expect(transition).toEqual({ exits: 0, enters: true });
  await page.getByRole("button", { name: "Настройки древа" }).click();
  await dialog
    .getByRole("switch", { name: "Ограничить видимое древо" })
    .uncheck();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(root).toHaveAttribute("data-renderer", "webgl2", {
    timeout: 30_000,
  });
  await expect(root).toHaveAttribute("data-layout-people", "600");
});
