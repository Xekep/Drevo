import { test, expect, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import type { Family, Person } from "../../src/domain/types.ts";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences.ts";

const names: Record<string, string> = {
  dad: "Александр",
  me: "Михаил",
  child: "Николай",
  sibling: "Алексей",
  nephew: "Евгений",
  aunt: "Надежда",
  cousin: "Варвара",
  another: "Сергей",
  "another-child": "Анастасия",
  isolate: "Наталья",
  "distant-a": "Павел",
  "distant-b": "Анна",
  "distant-c": "Ирина",
  wife: "Ольга",
  partner: "Елена",
  "second-child": "Иван",
};
const p = (
  id: string,
  parents: string[] = [],
  spouses: string[] = [],
): Person => ({
  id,
  name: names[id] || `Человек ${id}`,
  surname: "Соколов",
  patronymic: id === "sibling" ? "Александрович" : "",
  sex: id === "wife" || id === "partner" ? "f" : "m",
  birth: "1970",
  birthPlace: "",
  parents,
  spouses,
  sources: [],
  generation: 1,
  column: 0,
});
// The common ancestor and two unions must remain the same people during navigation.
const family: Family = {
  title: "Ветви",
  description: "",
  demo: false,
  photos: [],
  links: [],
  unions: [
    { id: "marriage", participants: ["sibling", "wife"], type: "marriage" },
    { id: "civil", participants: ["sibling", "partner"], type: "civil_union" },
  ],
  people: [
    p("dad"),
    p("me", ["dad"]),
    p("child", ["me"]),
    p("sibling", ["dad"], ["wife"]),
    p("wife", [], ["sibling"]),
    p("partner"),
    p("nephew", ["sibling", "wife"]),
    p("second-child", ["sibling", "partner"]),
    p("aunt", ["dad"]),
    p("cousin", ["aunt"]),
    p("another", ["dad"]),
    p("another-child", ["another"]),
    p("isolate"),
    p("distant-a"),
    p("distant-b"),
    p("distant-c"),
  ],
};

const world = (page: Page) => page.locator(".tree-spatial");
async function settle(page: Page) {
  await expect(world(page)).toHaveAttribute("aria-busy", "false");
  await expect(world(page)).toHaveAttribute("data-depth-moving", "false");
}
async function setup(page: Page, graph = family, canEdit = false) {
  const preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
    animateOnLoad: false,
    presentation: "depth",
  };
  const user = {
    id: "depth-user",
    name: "Участник",
    personId: "me",
    role: canEdit ? "editor" : "reader",
    treeRole: canEdit ? "editor" : "reader",
    approved: true,
    archiveOwner: false,
    treeAccess: "all",
    createdAt: "2026-10-15",
  };
  await page.addInitScript(() => {
    const state = window as unknown as { depthLayoutRequests: number };
    state.depthLayoutRequests = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      options?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (
        message &&
        typeof message === "object" &&
        "requestId" in message &&
        ("people" in message || "flat" in message)
      )
        state.depthLayoutRequests++;
      return Reflect.apply(
        send,
        this,
        options === undefined ? [message] : [message, options],
      );
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/api/family"))
      return route.fulfill({
        json: {
          family: graph,
          user,
          revision: 1,
          local: false,
          canEdit,
          readTree: true,
          readPhotos: true,
          treePreferences: preferences,
        },
      });
    if (path.endsWith("/api/session"))
      return route.fulfill({ json: { user, account: user, local: false } });
    if (path.endsWith("/api/tree-preferences")) {
      if (route.request().method() === "PUT")
        Object.assign(preferences, route.request().postDataJSON());
      return route.fulfill({ json: preferences });
    }
    return route.fulfill({
      json: { items: [], comments: [], unread: 0, categories: [] },
    });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-ready",
    "true",
    { timeout: 60_000 },
  );
  return preferences;
}
const workerRequests = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { depthLayoutRequests: number })
        .depthLayoutRequests,
  );

test("3D uses a bounded WebGL scene, free camera and native people navigation without new layout", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /THREE.WebGLProgram|Shader Error|VALIDATE_STATUS/.test(message.text())
    )
      errors.push(message.text());
  });
  await setup(page, family, true);
  await settle(page);
  await expect(page.locator(".tree-spatial-canvas")).toHaveCount(1);
  await expect(page.locator(".tree-spatial-orbit, .tree-spatial-add, .flow-add-tools")).toHaveCount(0);
  const cameraTools = page.getByRole("group", { name: "Масштаб 3D-древа", includeHidden: true });
  if (info.project.name === "mobile") await expect(cameraTools).toBeHidden();
  else await expect(cameraTools).toBeVisible();
  await expect(world(page)).toHaveAttribute(
    "data-depth-world-people",
    String(family.people.length),
  );
  await expect
    .poll(async () =>
      Number(await world(page).getAttribute("data-depth-cards")),
    )
    .toBeGreaterThan(0);
  expect(
    Number(await world(page).getAttribute("data-depth-cards")),
  ).toBeLessThanOrEqual(family.people.length);
  expect(
    Number(await world(page).getAttribute("data-depth-draw-calls")),
  ).toBeLessThanOrEqual(4);
  await page.screenshot({ path: info.outputPath("3d-initial.png") });
  const requests = await workerRequests(page),
    camera = await world(page).getAttribute("data-depth-camera");
  expect(requests).toBeGreaterThanOrEqual(2);
  await page.locator(".tree-spatial-canvas").focus();
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => world(page).getAttribute("data-depth-camera"))
    .not.toBe(camera);
  await settle(page);
  const canvas = page.locator(".tree-spatial-canvas");
  await canvas.focus();
  const beforePitch = await world(page).getAttribute("data-depth-camera");
  await page.keyboard.press("ArrowUp");
  await settle(page);
  await expect
    .poll(() => world(page).getAttribute("data-depth-camera"))
    .not.toBe(beforePitch);
  await canvas.focus();
  await page.keyboard.press("Home");
  await settle(page);
  await page.screenshot({ path: info.outputPath("3d-overview.png") });
  await page.locator(".tree-spatial-people summary").click();
  await page
    .getByRole("searchbox", { name: "Поиск в 3D-древе" })
    .fill("Алексей");
  await page.locator(".tree-spatial-people li button").focus();
  await page.keyboard.press("Enter");
  await expect(canvas).toBeFocused();
  await expect(page.locator(".tree-spatial-people")).not.toHaveAttribute(
    "open",
    "",
  );
  await settle(page);
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-depth-anchor",
    "sibling",
  );
  expect(await workerRequests(page)).toBe(requests);
  expect(
    Number(await world(page).getAttribute("data-depth-largest-card")),
  ).toBeLessThanOrEqual(info.project.name === "mobile" ? 150 : 190);
  await page.screenshot({ path: info.outputPath("3d-selected.png") });
  const atSibling = await world(page).getAttribute("data-depth-camera");
  await page.locator(".tree-spatial-person-name").click();
  await expect(page.getByRole("tab", { name: /О человеке/ })).toBeVisible();
  expect(await world(page).getAttribute("data-depth-camera")).toBe(atSibling);
  await settle(page);
  // In an idle scene no requestAnimationFrame/render loop remains alive.
  await page.waitForTimeout(700);
  const frames = await world(page).getAttribute("data-depth-frames");
  await page.waitForTimeout(500);
  expect(await world(page).getAttribute("data-depth-frames")).toBe(frames);
  expect(errors).toEqual([]);
});

test("a thousand-person 3D archive keeps GPU batches, textures and detail bounded", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const graph: Family = {
    ...family,
    unions: [],
    people: Array.from({ length: 1000 }, (_, i) =>
      p(String(i), i > 40 ? [String(Math.floor((i - 40) / 2))] : []),
    ),
  };
  await setup(page, graph);
  await settle(page);
  await expect(world(page)).toHaveAttribute("data-depth-world-people", "1000");
  const requests = await workerRequests(page);
  await page.locator(".tree-spatial-canvas").focus();
  await page.keyboard.press("Home");
  await settle(page);
  const before = await world(page).getAttribute("data-depth-camera");
  await page.keyboard.press("ArrowRight");
  await expect
    .poll(() => world(page).getAttribute("data-depth-camera"))
    .not.toBe(before);
  await settle(page);
  const stats = await world(page).evaluate((node) => ({
    people: node.getAttribute("data-depth-world-people"),
    cards: Number(node.getAttribute("data-depth-cards")),
    calls: Number(node.getAttribute("data-depth-draw-calls")),
    textures: Number(node.getAttribute("data-depth-textures")),
    bytes: Number(node.getAttribute("data-depth-texture-bytes")),
    tile: Number(node.getAttribute("data-depth-portrait-tile")),
    names: Number(node.getAttribute("data-depth-name-people")),
  }));
  expect(stats.cards).toBe(1000);
  expect(stats.calls).toBeLessThanOrEqual(4);
  expect(stats.bytes).toBe(21 * 1024 * 1024);
  expect(stats.tile).toBe(64);
  expect(stats.names).toBe(1000);
  if (!process.env.DREVO_E2E_NO_SCREENSHOTS)
    await page.screenshot({ path: info.outputPath("3d-1000-overview.png") });
  expect(stats.textures).toBeLessThanOrEqual(3);
  expect(await workerRequests(page)).toBe(requests);
  await info.attach("webgl-1000-bounds", {
    body: JSON.stringify(stats),
    contentType: "application/json",
  });
  const beforeDrag = await world(page).evaluate((node) => ({
    frames: Number(node.getAttribute("data-depth-frames")),
    cpu: Number(node.getAttribute("data-depth-cpu-ms")),
  }));
  const box = (await page.locator(".tree-spatial-canvas").boundingBox())!;
  const start = { x: box.x + box.width * 0.5, y: box.y + box.height * 0.5 };
  if (info.project.name === "desktop") {
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x + 100, start.y + 35, { steps: 20 });
    await page.mouse.up();
  } else {
    const session = await page.context().newCDPSession(page);
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [start],
    });
    for (let i = 1; i <= 12; i++) {
      await session.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: start.x + i * 6, y: start.y + i * 2 }],
      });
      await page.waitForTimeout(16);
    }
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
  }
  await settle(page);
  const afterDrag = await world(page).evaluate((node) => ({
    frames: Number(node.getAttribute("data-depth-frames")),
    cpu: Number(node.getAttribute("data-depth-cpu-ms")),
  }));
  expect(afterDrag.frames).toBeGreaterThan(beforeDrag.frames);
  const dragResult = JSON.stringify({
    frames: afterDrag.frames - beforeDrag.frames,
    meanCpuMs:
      (afterDrag.cpu - beforeDrag.cpu) / (afterDrag.frames - beforeDrag.frames),
  });
  const dragPath = info.outputPath("native-drag-cpu.json");
  await writeFile(dragPath, dragResult);
  await info.attach("webgl-1000-native-drag-cpu", {
    path: dragPath,
    contentType: "application/json",
  });
  expect(await workerRequests(page)).toBe(requests);
  await page.waitForTimeout(700);
  const frames = await world(page).getAttribute("data-depth-frames");
  await page.waitForTimeout(500);
  expect(await world(page).getAttribute("data-depth-frames")).toBe(frames);
});

test("all two hundred portraits and names stay present in the overview and after zoom", async ({
  page,
}, info) => {
  test.setTimeout(120_000);
  const portrait = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" fill="#8aa186"/><circle cx="48" cy="34" r="18" fill="#ede0cc"/><ellipse cx="48" cy="89" rx="31" ry="33" fill="#435e46"/></svg>`;
  let loads = 0;
  await page.route("**/media/3d-portrait-*", async (route) => {
    loads++;
    await route.fulfill({ contentType: "image/svg+xml", body: portrait });
  });
  const graph: Family = {
    ...family,
    unions: [],
    people: Array.from({ length: 200 }, (_, i) => ({
      ...p(String(i), i > 20 ? [String(Math.floor((i - 20) / 2))] : []),
      photo: `/media/3d-portrait-${i}.jpg`,
      patronymic: "Александрович",
    })),
  };
  await setup(page, graph);
  await settle(page);
  const requests = await workerRequests(page);
  await page.locator(".tree-spatial-canvas").focus();
  await page.keyboard.press("Home");
  await settle(page);
  await expect.poll(() => loads).toBe(200);
  await expect(world(page)).toHaveAttribute("data-depth-cards", "200");
  await page.screenshot({ path: info.outputPath("3d-200-overview.png") });
  await page.locator(".tree-spatial-canvas").focus();
  await page.keyboard.press("-");
  await settle(page);
  await expect(world(page)).toHaveAttribute("data-depth-cards", "200");
  expect(loads).toBe(200);
  expect(await workerRequests(page)).toBe(requests);
});

test("3D has an explicit ordinary-view recovery when WebGL is unavailable", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (
      this: HTMLCanvasElement,
      ...args: Parameters<HTMLCanvasElement["getContext"]>
    ) {
      if (String(args[0]).startsWith("webgl")) return null;
      return Reflect.apply(original, this, args);
    } as HTMLCanvasElement["getContext"];
  });
  await setup(page);
  await page
    .getByRole("button", { name: "Открыть обычное древо", exact: true })
    .click();
  await expect(page.locator(".tree-spatial")).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).not.toHaveAttribute(
    "data-depth-anchor",
    /.+/,
  );
  await expect(page.locator(".flow-person-content").first()).toBeVisible();
});

test("native mobile hold selects a 3D person without opening the profile", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "mobile");
  await setup(page);
  await settle(page);
  const canvas = page.locator(".tree-spatial-canvas"),
    box = (await canvas.boundingBox())!;
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const session = await page.context().newCDPSession(page);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [point],
  });
  await page.waitForTimeout(650);
  await session.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await session.detach();
  await expect(world(page)).toHaveAttribute("data-depth-selected", "me");
  await expect(page.locator(".inspector-dock")).toHaveCount(0);
  await expect(page).toHaveURL(/\/tree$/);
  await page.touchscreen.tap(point.x, point.y);
  await expect(page.getByRole("tab", { name: /О человеке/ })).toBeVisible();
});

test("3D middle click sets the generation anchor and middle drag only pans", async ({
  page,
}, info) => {
  test.skip(info.project.name !== "desktop");
  const preferences = await setup(page);
  await settle(page);
  const box = (await page.locator(".tree-spatial-canvas").boundingBox())!;
  const x = box.x + box.width / 2,
    y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(x + 80, y + 40, { steps: 8 });
  await page.mouse.up({ button: "middle" });
  expect(preferences.generationLimits).toBeUndefined();
  await page
    .getByRole("button", { name: "Перейти к ветви: Соколов Михаил", exact: true })
    .click();
  await settle(page);
  await page.mouse.click(x, y, { button: "middle" });
  await expect.poll(() => preferences.generationLimits?.anchorId).toBe("me");
});
