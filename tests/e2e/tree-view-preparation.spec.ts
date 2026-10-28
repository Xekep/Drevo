import { expect, test, type Page } from "@playwright/test";
import { familyViewAction } from "./tree-toolbar-actions";

async function delayedFragment(page: Page, presentation: "flat" | "depth" = "flat") {
  let requestedOverview = false;
  let releaseOverview!: () => void;
  const overviewGate = new Promise<void>(resolve => { releaseOverview = resolve; });
  await page.route("**/api/family?projection=overview*", async route => {
    const response = await route.fetch(), data = await response.json();
    const base = data.family.people[0];
    const people = [
      { ...base, id: "view-child", name: "Потомок", surname: "Проверка", patronymic: "", birth: "2000", parents: ["view-parent"], spouses: [], photo: undefined },
      { ...base, id: "view-parent", name: "Родитель", surname: "Проверка", patronymic: "", birth: "1970", parents: ["view-grandparent"], spouses: [], photo: undefined },
      { ...base, id: "view-grandparent", name: "Предок", surname: "Проверка", patronymic: "", birth: "1940", parents: [], spouses: [], photo: undefined },
    ];
    const query = new URL(route.request().url()).searchParams;
    const initial = route.request().headers()["x-drevo-fragment"] === "auto" || query.get("fragment") === "auto";
    if (!initial) {
      requestedOverview = true;
      await overviewGate;
    }
    const shown = initial ? people.slice(0, 2).map(person => ({ ...person, parents: person.parents.filter((id: string) => id !== "view-grandparent") })) : people;
    data.family = { ...data.family, people: shown, links: [], unions: [], photos: [], documents: [] };
    data.totals.people = 3;
    data.user.personId = "view-child";
    data.partial = initial;
    data.treePreferences = { ...data.treePreferences, presentation, fragmentThreshold: 500, animateOnLoad: false };
    if (initial) data.fragment = {
      anchorId: "view-child", ancestors: 3, descendants: 3, collateral: 1,
      expanded: [], hidden: [["view-parent", 1]], atLimit: false, nextOffset: 0,
      total: 3, peopleIds: shown.map(person => person.id),
    };
    else delete data.fragment;
    await route.fulfill({ response, json: data });
  });
  return { requested: () => requestedOverview, release: () => releaseOverview() };
}

test("fan preparation uses the committed complete graph rather than the initial fragment", async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const overview = await delayedFragment(page);
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-layout-ready", "true");
  await expect(canvas).not.toHaveClass(/is-grow|is-layout-settling/);
  await page.locator('.flow-person[data-person-id="view-child"] .flow-person-content').click();
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Свернуть панель", exact: true }).click();
  await familyViewAction(page, "Веер");
  await expect.poll(overview.requested).toBe(true);
  await expect(page.locator(".fan-chart")).toHaveCount(0);
  overview.release();
  const fan = page.locator(".fan-chart");
  await expect(fan).toBeVisible();
  await expect(fan).toHaveAttribute("aria-label", "Веер предков: Проверка Потомок");
  await expect(fan.locator(".fan-chart-meta")).toContainText("2 известных предка");
  await expect(fan.locator('[data-fan-generation="2"] title')).toHaveText("Проверка Предок");
});

test("choosing the ordinary recovery cancels pending fan preparation", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: Parameters<HTMLCanvasElement["getContext"]>) {
      if (String(args[0]).startsWith("webgl")) return null;
      return Reflect.apply(original, this, args);
    } as HTMLCanvasElement["getContext"];
  });
  const overview = await delayedFragment(page, "depth");
  await page.goto("/people/view-child");
  const recovery = page.getByRole("button", { name: "Открыть обычное древо", exact: true });
  await expect(recovery).toBeVisible();
  await familyViewAction(page, "Веер");
  await expect.poll(overview.requested).toBe(true);
  await recovery.click();
  await expect(page.locator(".tree-spatial")).toHaveCount(0);
  overview.release();
  await expect(page.getByTestId("rf__node-view-grandparent")).toBeVisible();
  await expect(page.locator(".fan-chart")).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-fan/);
});

test("a late person-navigation microtask cannot reopen a fan after switching to the timeline", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.addInitScript(() => {
    const native = window.queueMicrotask.bind(window);
    const gate = { armed: false, path: "", heading: "", pending: [] as VoidFunction[], flush: () => {} };
    gate.flush = () => { gate.armed = false; gate.pending.splice(0).forEach(native); };
    Object.assign(window, { fanFocusGate: gate });
    window.queueMicrotask = callback => {
      // Let React commit the newly selected profile first. Hold the following
      // navigation microtask, rather than React's initial update scheduler.
      if (gate.armed && location.pathname !== gate.path && document.querySelector(".fan-chart") &&
        document.querySelector(".inspector-dock h2")?.textContent !== gate.heading) {
        gate.armed = false;
        gate.pending.push(callback);
      } else native(callback);
    };
  });
  await page.goto("/people/e2e-child");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await familyViewAction(page, "Веер");
  await expect(page.locator(".fan-chart")).toBeVisible();
  await page.evaluate(() => {
    const gate = (window as typeof window & { fanFocusGate: { armed: boolean; path: string; heading: string } }).fanFocusGate;
    gate.path = location.pathname;
    gate.heading = document.querySelector(".inspector-dock h2")?.textContent || "";
    gate.armed = true;
  });
  await page.locator(".inspector-dock .relatives button").first().click();
  await expect.poll(() => page.evaluate(() =>
    (window as typeof window & { fanFocusGate: { pending: VoidFunction[] } }).fanFocusGate.pending.length,
  )).toBe(1);
  await page.getByRole("button", { name: "Хронология", exact: true }).click();
  await expect(page.locator(".tree-canvas")).toHaveClass(/mode-timeline/);
  await page.evaluate(() =>
    (window as typeof window & { fanFocusGate: { flush: () => void } }).fanFocusGate.flush(),
  );
  await expect(page.locator(".fan-chart")).toHaveCount(0);
  await expect(page.locator(".timeline-board")).toBeVisible();
  await expect(page.locator(".tree-canvas")).toHaveClass(/mode-timeline/);
});

test("returning to the whole tree cancels a mode preparation that has not committed", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Keep fragment metadata after the full graph has been demanded. Subsequent
  // preparations still cross the async overview/React commit boundary.
  await page.route("**/api/family?projection=overview*", async route => {
    const response = await route.fetch(), data = await response.json();
    data.fragment = {
      anchorId: "e2e-child", ancestors: 3, descendants: 3, collateral: 1,
      expanded: [], hidden: [], atLimit: false, nextOffset: 0,
      total: data.family.people.length, peopleIds: data.family.people.map((person: { id: string }) => person.id),
    };
    data.graphComplete = true;
    data.treePreferences = { ...data.treePreferences, animateOnLoad: false };
    await route.fulfill({ response, json: data });
  });
  await page.goto("/people/e2e-child");
  await expect(page.locator(".tree-canvas")).not.toHaveClass(/is-grow|is-layout-settling/);
  await familyViewAction(page, "Веер");
  await expect(page.locator(".fan-chart")).toBeVisible();
  await page.evaluate(() => {
    const timeline = [...document.querySelectorAll<HTMLButtonElement>(".tree-canvas button")]
      .find(button => button.textContent === "Хронология")!;
    const all = [...document.querySelectorAll<HTMLButtonElement>(".tree-family-tools button")]
      .find(button => button.textContent === "Всё древо")!;
    timeline.click();
    all.click();
  });
  await expect(page.locator(".fan-chart")).toHaveCount(0);
  await expect(page.locator(".tree-canvas")).toHaveClass(/mode-generations/);
  await expect(page.locator(".timeline-board")).toHaveCount(0);
  await expect(page.getByTestId("rf__node-e2e-child")).toBeVisible();
});
