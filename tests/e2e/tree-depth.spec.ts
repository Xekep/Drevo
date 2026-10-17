import { test, expect, type Page } from "@playwright/test";
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
async function setup(page: Page, graph = family) {
  const preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
    animateOnLoad: false,
    presentation: "depth",
  };
  const user = {
    id: "depth-user",
    name: "Участник",
    personId: "me",
    role: "reader",
    treeRole: "reader",
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
          canEdit: false,
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
  await setup(page);
  await settle(page);
  await expect(page.locator(".tree-spatial-canvas")).toHaveCount(1);
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
  ).toBeLessThanOrEqual(32);
  expect(
    Number(await world(page).getAttribute("data-depth-draw-calls")),
  ).toBeLessThanOrEqual(4);
  await page.screenshot({ path: info.outputPath("3d-initial.png") });
  const requests = await workerRequests(page),
    camera = await world(page).getAttribute("data-depth-camera");
  expect(requests).toBeGreaterThanOrEqual(2);
  await page
    .getByRole("button", { name: "Повернуть пространство вправо", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Вписать видимую часть древа", exact: true })
    .click();
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
  await page
    .getByRole("button", { name: "Вписать видимую часть древа", exact: true })
    .click();
  await settle(page);
  const before = await world(page).getAttribute("data-depth-camera");
  await page
    .getByRole("button", { name: "Повернуть пространство вправо", exact: true })
    .click();
  await expect
    .poll(() => world(page).getAttribute("data-depth-camera"))
    .not.toBe(before);
  await settle(page);
  const stats = await world(page).evaluate((node) => ({
    people: node.getAttribute("data-depth-world-people"),
    cards: Number(node.getAttribute("data-depth-cards")),
    calls: Number(node.getAttribute("data-depth-draw-calls")),
    textures: Number(node.getAttribute("data-depth-textures")),
  }));
  expect(stats.cards).toBeLessThanOrEqual(32);
  expect(stats.calls).toBeLessThanOrEqual(4);
  expect(stats.textures).toBeLessThanOrEqual(1);
  expect(await workerRequests(page)).toBe(requests);
  await info.attach("webgl-1000-bounds", {
    body: JSON.stringify(stats),
    contentType: "application/json",
  });
  await page.waitForTimeout(700);
  const frames = await world(page).getAttribute("data-depth-frames");
  await page.waitForTimeout(500);
  expect(await world(page).getAttribute("data-depth-frames")).toBe(frames);
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
    .getByRole("button", { name: "Вернуть ракурс ветви", exact: true })
    .click();
  await settle(page);
  await page.mouse.click(x, y, { button: "middle" });
  await expect.poll(() => preferences.generationLimits?.anchorId).toBe("me");
});
