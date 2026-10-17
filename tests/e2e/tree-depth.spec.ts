import { test, expect, type Page } from "@playwright/test";
import type { Family, Person } from "../../src/domain/types.ts";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences.ts";

const names: Record<string, string> = {
  dad: "Александр", me: "Михаил", child: "Николай", sibling: "Алексей",
  nephew: "Евгений", aunt: "Надежда", cousin: "Варвара", another: "Сергей",
  "another-child": "Анастасия", isolate: "Наталья", "distant-a": "Павел",
  "distant-b": "Анна", "distant-c": "Ирина", wife: "Ольга", partner: "Елена",
  "second-child": "Иван",
};
const p = (id: string, parents: string[] = [], spouses: string[] = []): Person => ({
  id, name: names[id], surname: "Соколов",
  patronymic: id === "sibling" ? "Александрович" : "",
  sex: id === "wife" || id === "partner" ? "f" : "m",
  birth: "1970", birthPlace: "", parents, spouses, sources: [], generation: 1, column: 0,
});
// The common ancestor and two unions must remain the same people during navigation.
const family: Family = {
  title: "Ветви", description: "", demo: false, photos: [], links: [],
  unions: [
    { id: "marriage", participants: ["sibling", "wife"], type: "marriage" },
    { id: "civil", participants: ["sibling", "partner"], type: "civil_union" },
  ],
  people: [
    p("dad"), p("me", ["dad"]), p("child", ["me"]),
    p("sibling", ["dad"], ["wife"]), p("wife", [], ["sibling"]),
    p("partner"), p("nephew", ["sibling", "wife"]),
    p("second-child", ["sibling", "partner"]),
    p("aunt", ["dad"]), p("cousin", ["aunt"]),
    p("another", ["dad"]), p("another-child", ["another"]),
    p("isolate"), p("distant-a"), p("distant-b"), p("distant-c"),
  ],
};

const card = (page: Page, id: string) => page.locator(`[data-depth-person="${id}"]`);
const world = (page: Page) => page.locator(".tree-depth-world");

async function settle(page: Page) {
  await expect(world(page)).toHaveAttribute("data-depth-moving", "false");
  // Both the spatial camera and React Flow pan/zoom must finish, rather than sleeping
  // for an assumed animation duration (which differs with reduced motion).
  let previous = "", repeats = 0;
  await expect.poll(async () => {
    const current = await page.locator(".react-flow__viewport").getAttribute("style");
    repeats = current === previous ? repeats + 1 : 0;
    previous = current || "";
    return repeats;
  }, { intervals: [100], timeout: 10_000 }).toBeGreaterThanOrEqual(3);
  await expect(world(page)).toHaveAttribute("data-depth-moving", "false");
}

const workerRequests = (page: Page) => page.evaluate(() =>
  (window as unknown as { depthLayoutRequests: number }).depthLayoutRequests);

const worldPoint = (page: Page, id: string) => card(page, id).evaluate((node) => ({
  x: node.getAttribute("data-world-x"),
  y: node.getAttribute("data-world-y"),
  z: node.getAttribute("data-world-z"),
}));

async function wholeTree(page: Page) {
  await page.getByRole("button", { name: "Вписать видимую часть древа", exact: true }).click();
  await settle(page);
}

async function roundPortrait(page: Page, id: string) {
  const avatar = card(page, id).locator(".person-avatar");
  const box = await avatar.boundingBox();
  expect(box).not.toBeNull();
  expect(Math.abs(box!.width - box!.height)).toBeLessThan(1);
  expect(await avatar.evaluate((node) => getComputedStyle(node).borderRadius)).toBe("50%");
}

test("2.5D keeps one connected world while the camera rotates and changes branches", async ({ page }, info) => {
  test.setTimeout(90_000);
  let preferences: TreePreferences = { ...DEFAULT_TREE_PREFERENCES, animateOnLoad: false };
  const user = {
    id: "depth-user", name: "Участник", personId: "me", role: "reader", treeRole: "reader",
    approved: true, archiveOwner: false, treeAccess: "all", createdAt: "2026-10-15",
  };
  await page.addInitScript(() => {
    const state = window as unknown as { depthLayoutRequests: number };
    state.depthLayoutRequests = 0;
    const send = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (
      this: Worker,
      message: unknown,
      transferOrOptions?: Transferable[] | StructuredSerializeOptions,
    ) {
      if (message && typeof message === "object" && "requestId" in message && "people" in message)
        state.depthLayoutRequests++;
      return Reflect.apply(send, this, transferOrOptions === undefined
        ? [message]
        : [message, transferOrOptions]);
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/api/family")) return route.fulfill({ json: {
      family, user, revision: 1, local: false, canEdit: false, readTree: true,
      readPhotos: true, treePreferences: preferences,
    } });
    if (path.endsWith("/api/session")) return route.fulfill({ json: { user, account: user, local: false } });
    if (path.endsWith("/api/tree-preferences")) {
      if (route.request().method() === "PUT") preferences = route.request().postDataJSON();
      return route.fulfill({ json: preferences });
    }
    return route.fulfill({ json: { items: [], comments: [], unread: 0, categories: [] } });
  });
  await page.goto("/tree");
  const scene = page.locator(".tree-canvas");
  await expect(scene).toHaveAttribute("data-layout-ready", "true");
  await page.getByRole("button", { name: "Настройки древа", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Вид древа" });
  await dialog.getByRole("radio", { name: "2.5D", exact: true }).check();
  await expect.poll(() => preferences.presentation).toBe("depth");
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(scene).toHaveAttribute("data-depth-anchor", "me");
  await expect(scene).toHaveAttribute("data-layout-people", String(family.people.length));
  await expect(world(page)).toHaveAttribute("data-depth-world-people", String(family.people.length));
  await settle(page);
  await roundPortrait(page, "me");
  const initialCard = card(page, "me");
  const initialButton = initialCard.locator(".tree-depth-person-content");
  await initialButton.hover();
  await expect.poll(() => initialButton.evaluate((node) => getComputedStyle(node).backgroundColor))
    .toBe("rgb(237, 242, 234)");
  expect(await initialCard.locator(".person-avatar").evaluate((node) => getComputedStyle(node).boxShadow))
    .toContain("rgb(237, 242, 234)");
  // Restore the resting appearance for the shared visual evidence.
  await page.mouse.move(5, 5);
  await page.screenshot({ path: info.outputPath("depth-initial.png") });
  await wholeTree(page);

  const branch = page.getByRole("button", { name: /Перейти к ветви: Соколов Алексей Александрович,/ });
  await expect(branch).toBeVisible();
  const edge = page.locator('.tree-depth-connection[data-depth-from="dad"][data-depth-to="sibling"]');
  await expect(edge).toHaveCount(1);
  await expect(page.locator('.tree-depth-connection[data-depth-to="isolate"]')).toHaveCount(0);
  const sharedAncestor = await worldPoint(page, "dad");
  const siblingPoint = await worldPoint(page, "sibling");
  expect(Object.values(sharedAncestor).every((value) => value !== null)).toBe(true);
  const requests = await workerRequests(page);
  expect(requests).toBeGreaterThan(0);
  await card(page, "sibling").evaluate((node) => node.setAttribute("data-test-identity", "same-person"));
  const beforeTransform = await card(page, "sibling").getAttribute("style");
  const beforePath = await edge.getAttribute("d");
  await page.getByRole("button", { name: "Повернуть пространство вправо", exact: true }).click();
  await expect(world(page)).toHaveAttribute("data-depth-moving", "true");
  // Read line and card coordinates from the same browser frame. Independently animated
  // layers used to leave a line pointing at the old position during a camera turn.
  const samples = await page.evaluate(async () => {
    const errors: number[] = [], paths = new Set<string>();
    for (let i = 0; i < 12; i++) {
      await new Promise(requestAnimationFrame);
      const line = document.querySelector<SVGPathElement>('[data-depth-from="dad"][data-depth-to="sibling"]');
      const person = document.querySelector<HTMLElement>('[data-depth-person="sibling"]');
      if (!line || !person || !line.getScreenCTM()) continue;
      const endpoint = line.getPointAtLength(line.getTotalLength()).matrixTransform(line.getScreenCTM()!);
      const box = person.getBoundingClientRect();
      const leader = document.querySelector<SVGPathElement>('[data-depth-leader="sibling"]');
      if (leader && leader.getScreenCTM()) {
        // Dense overviews may move only a compact hit target away from its true
        // projected point. The visible leader must keep that exact connection.
        const start = leader.getPointAtLength(0).matrixTransform(leader.getScreenCTM()!);
        const end = leader.getPointAtLength(leader.getTotalLength()).matrixTransform(leader.getScreenCTM()!);
        errors.push(
          Math.abs(endpoint.x - start.x), Math.abs(endpoint.y - start.y),
          Math.abs(end.x - (box.left + box.width / 2)),
          Math.abs(end.y - (box.top + box.height / 2)),
        );
      } else {
        errors.push(Math.abs(endpoint.x - (box.left + box.width / 2)));
      }
      paths.add(line.getAttribute("d") || "");
    }
    return { errors, paths: paths.size };
  });
  expect(samples.errors.length).toBeGreaterThan(5);
  expect(Math.max(...samples.errors)).toBeLessThan(2);
  expect(samples.paths).toBeGreaterThan(1);
  await settle(page);
  await expect(world(page)).toHaveAttribute("data-depth-yaw", "12.00");
  expect(await card(page, "sibling").getAttribute("style")).not.toBe(beforeTransform);
  expect(await edge.getAttribute("d")).not.toBe(beforePath);
  await expect(card(page, "sibling")).toHaveAttribute("data-test-identity", "same-person");
  await page.getByRole("button", { name: "Вернуть ракурс ветви", exact: true }).click();
  await settle(page);
  await expect(world(page)).toHaveAttribute("data-depth-yaw", "0.00");
  expect(await card(page, "sibling").getAttribute("style")).toBe(beforeTransform);
  expect(await edge.getAttribute("d")).toBe(beforePath);
  expect(await workerRequests(page)).toBe(requests);
  expect(await branch.evaluate((node) => !!node.closest(".react-flow__viewport"))).toBe(true);
  await expect(page.locator(".tree-depth-stack, .tree-depth-layers")).toHaveCount(0);

  // Use an actual empty pan surface, not a point accidentally covered by a card.
  const dragStart = await page.locator(".react-flow").evaluate((flow) => {
    const box = flow.getBoundingClientRect();
    for (const ry of [.18, .35, .65, .8]) for (const rx of [.12, .4, .75]) {
      const x = box.x + box.width * rx, y = box.y + box.height * ry;
      if (document.elementFromPoint(x, y)?.classList.contains("react-flow__pane")) return { x, y };
    }
    throw new Error("No empty tree pane for a real drag gesture");
  });
  const beforePan = await branch.boundingBox();
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 48, dragStart.y - 24, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await branch.boundingBox())!.x - beforePan!.x)).toBeGreaterThan(20);
  await wholeTree(page);
  await page.screenshot({ path: info.outputPath("depth-branches.png") });

  await branch.focus();
  await page.keyboard.press("Enter");
  await expect(scene).toHaveAttribute("data-depth-anchor", "sibling");
  await settle(page);
  const chosen = page.getByRole("button", { name: "Открыть карточку: Соколов Алексей Александрович", exact: true });
  await expect(chosen).toBeFocused();
  await expect(world(page)).toHaveAttribute("data-depth-world-people", String(family.people.length));
  await expect(scene).toHaveAttribute("data-layout-people", String(family.people.length));
  expect(await worldPoint(page, "dad")).toEqual(sharedAncestor);
  expect(await worldPoint(page, "sibling")).toEqual(siblingPoint);
  await roundPortrait(page, "sibling");
  expect((await card(page, "sibling").locator(".tree-depth-person-years").boundingBox())!.height)
    .toBeGreaterThanOrEqual(12);
  expect(await workerRequests(page)).toBe(requests);
  await expect(page.locator('.tree-depth-connection[data-depth-to="nephew"][data-depth-from="sibling"]')).toHaveCount(1);
  await expect(page.locator('.tree-depth-connection[data-depth-to="second-child"][data-depth-from="partner"]')).toHaveCount(1);
  await page.screenshot({ path: info.outputPath("depth-selected-branch.png") });

  const cameraBeforeProfile = await page.locator(".react-flow__viewport").getAttribute("style");
  const yawBeforeProfile = await world(page).getAttribute("data-depth-yaw");
  const pointBeforeProfile = await card(page, "sibling").getAttribute("style");
  await chosen.click();
  await expect(page.getByRole("button", { name: "Закрыть панель", exact: true })).toBeVisible();
  await expect(scene).toHaveAttribute("data-depth-anchor", "sibling");
  await expect(world(page)).toHaveAttribute("data-depth-moving", "false");
  expect(await world(page).getAttribute("data-depth-yaw")).toBe(yawBeforeProfile);
  expect(await card(page, "sibling").getAttribute("style")).toBe(pointBeforeProfile);
  expect(await page.locator(".react-flow__viewport").getAttribute("style")).toBe(cameraBeforeProfile);
  await page.getByRole("button", { name: "Закрыть панель", exact: true }).click();
  await page.getByRole("button", { name: "Предыдущая ветвь", exact: true }).click();
  await expect(scene).toHaveAttribute("data-depth-anchor", "me");
  await settle(page);
  await wholeTree(page);
  await branch.click();
  await expect(scene).toHaveAttribute("data-depth-anchor", "sibling");
  await settle(page);
  expect(await workerRequests(page)).toBe(requests);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  await page.getByRole("button", { name: "Настройки древа", exact: true }).click();
  await dialog.getByRole("radio", { name: "Обычное", exact: true }).check();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await expect(scene).not.toHaveAttribute("data-depth-anchor");
  await expect(world(page)).toHaveCount(0);
  await expect(scene).toHaveAttribute("data-layout-people", String(family.people.length));

  // Reduced motion changes the same camera immediately instead of flying a CSS plane.
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.getByRole("button", { name: "Настройки древа", exact: true }).click();
  await dialog.getByRole("radio", { name: "2.5D", exact: true }).check();
  await dialog.getByRole("button", { name: "Закрыть", exact: true }).click();
  await settle(page);
  const initialYaw = Number(await world(page).getAttribute("data-depth-yaw"));
  await page.getByRole("button", { name: "Повернуть пространство влево", exact: true }).click();
  await expect(world(page)).toHaveAttribute("data-depth-yaw", (initialYaw - 12).toFixed(2));
  await expect(world(page)).toHaveAttribute("data-depth-moving", "false");
  expect(await page.locator(".tree-flow-plane").evaluate((node) => node.getAnimations().length)).toBe(0);
});
