import { test, expect, type Page } from "@playwright/test";
import {
  DEFAULT_TREE_PREFERENCES,
  type TreePreferences,
} from "../../src/domain/tree-preferences.ts";
import { familyViewAction } from "./tree-toolbar-actions.ts";

async function calendar(page: Page, personId: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/notifications?memorial=1**", (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: "calendar-person",
            kind: "birthday",
            personId,
            personName: "Человек из календаря",
            birth: "1990-11-07",
            date: "2026-11-07",
            years: 36,
            days: 0,
          },
        ],
      },
    }),
  );
}
async function clickCalendar(page: Page) {
  await page.evaluate(() => {
    Object.assign(window, { calendarNavigationProbe: "same-document" });
  });
  let documents = 0;
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame())
      documents++;
  });
  await page.getByRole("button", { name: /^Уведомления/ }).click();
  await page
    .getByRole("region", { name: "Ближайшие памятные даты" })
    .getByRole("link", { name: /Человек из календаря/ })
    .click();
  return async () => {
    expect(documents).toBe(0);
    expect(
      await page.evaluate(
        () =>
          (window as typeof window & { calendarNavigationProbe?: string })
            .calendarNavigationProbe,
      ),
    ).toBe("same-document");
  };
}

test("calendar navigation unfolds a hidden branch without a document reload", async ({
  page,
}) => {
  await calendar(page, "e2e-grandchild");
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-camera-ready", "true");
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  await page
    .getByTestId("rf__node-e2e-child")
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ })
    .click();
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
  const verifyDocument = await clickCalendar(page);
  await expect(page).toHaveURL(/\/people\/e2e-grandchild$/);
  await expect(canvas).toHaveAttribute("data-layout-people", "6");
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toBeVisible();
  await verifyDocument();
});

test("hidden calendar person receives an animated camera flight after the branch opens", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop");
  await calendar(page, "e2e-grandchild");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/tree");
  const canvas = page.locator(".tree-canvas");
  await expect(canvas).toHaveAttribute("data-camera-ready", "true");
  await expect(canvas).not.toHaveClass(/is-growing|is-layout-settling/);
  await page.getByTestId("rf__node-e2e-child")
    .getByRole("button", { name: /Свернуть (потомков|ветвь)/ }).click();
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toHaveCount(0);
  await page.evaluate(() => {
    const viewport = document.querySelector(".react-flow__viewport");
    if (!viewport) throw new Error("Camera viewport not found");
    const values: string[] = [];
    (window as typeof window & { memorialCameraFrames?: string[] }).memorialCameraFrames = values;
    const observer = new MutationObserver(() => {
      const value = viewport.getAttribute("style") || "";
      if (!values.includes(value)) values.push(value);
    });
    observer.observe(viewport, { attributes: true, attributeFilter: ["style"] });
    window.addEventListener("pagehide", () => observer.disconnect(), { once: true });
  });
  const verifyDocument = await clickCalendar(page);
  await expect(page.getByTestId("rf__node-e2e-grandchild")).toBeVisible();
  await expect.poll(async () => page.evaluate(() => {
    const node = document.querySelector('[data-testid="rf__node-e2e-grandchild"]');
    const canvas = document.querySelector(".tree-canvas");
    if (!node || !canvas) return Infinity;
    const target = node.getBoundingClientRect(), area = canvas.getBoundingClientRect();
    return Math.hypot(target.x + target.width / 2 - (area.x + area.width / 2),
      target.y + target.height / 2 - (area.y + area.height / 2));
  })).toBeLessThan(80);
  expect(await page.evaluate(() =>
    (window as typeof window & { memorialCameraFrames?: string[] }).memorialCameraFrames?.length || 0,
  )).toBeGreaterThan(2);
  await verifyDocument();
});

test("calendar navigation removes a generation window for an excluded person", async ({
  page,
}) => {
  await calendar(page, "e2e-sibling");
  let preferences: TreePreferences = {
    ...DEFAULT_TREE_PREFERENCES,
    animateOnLoad: false,
    generationLimits: {
      anchorId: "e2e-child",
      ancestors: 3,
      descendants: 1,
      collateral: 0,
    },
  };
  const writes: TreePreferences[] = [];
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch(),
      data = await response.json();
    data.user.personId = null;
    await route.fulfill({
      response,
      json: { ...data, treePreferences: preferences },
    });
  });
  await page.route("**/api/tree-preferences", (route) => {
    if (route.request().method() === "PUT") {
      preferences = route.request().postDataJSON();
      writes.push(preferences);
    }
    return route.fulfill({ json: preferences });
  });
  await page.goto("/tree");
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-people",
    "4",
  );
  const verifyDocument = await clickCalendar(page);
  await expect(page).toHaveURL(/\/people\/e2e-sibling$/);
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-layout-people",
    "6",
  );
  expect(writes).toHaveLength(1);
  expect(writes[0].generationLimits).toBeNull();
  await verifyDocument();
});

test("calendar navigation to an already visible person keeps the family mode", async ({
  page,
}, info) => {
  await calendar(page, "e2e-child");
  await page.goto("/people/e2e-child");
  await expect(page.locator(".tree-canvas")).toHaveAttribute(
    "data-camera-ready",
    "true",
  );
  if (info.project.name === "mobile")
    await page.getByRole("button", { name: "Свернуть панель", exact: true }).click();
  await familyViewAction(page, "Близкие");
  await expect(
    page.getByRole("button", { name: "Всё древо", exact: true, includeHidden: true }),
  ).toHaveCount(1);
  const verifyDocument = await clickCalendar(page);
  await expect(page).toHaveURL(/\/people\/e2e-child$/);
  await expect(
    page.getByRole("button", { name: "Всё древо", exact: true, includeHidden: true }),
  ).toHaveCount(1);
  await verifyDocument();
});
