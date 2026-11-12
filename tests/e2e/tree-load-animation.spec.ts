import { expect, test } from "@playwright/test";
import { DEFAULT_TREE_PREFERENCES } from "../../src/domain/tree-preferences";
import { branchingFamily } from "../layout-fixtures";

for (const large of [false, true])
  for (const cached of [false, true])
    test(`disabled drawing exposes only the fitted overview before the account flight (${large ? "large" : "ordinary"}, ${cached ? "cached" : "fresh"})`, async ({
      page,
      isMobile,
    }) => {
      test.setTimeout(45_000);
      await page.route("**/api/family?projection=overview", async (route) => {
        const response = await route.fetch();
        const data = await response.json();
        if (large) {
          const template = data.family.people[0];
          // Keep the large connected graph while isolating camera startup.
          // Crowded crossing optimization has its own whole-tree regressions.
          data.family.people = branchingFamily(503).map((person) => ({
            ...template,
            ...person,
            name: person.id,
            surname: "Тестов",
            patronymic: "",
            photo: undefined,
            death: undefined,
            deceased: false,
            sources: [],
            events: [],
          }));
          data.family.links = [];
          data.family.unions = [];
          data.family.photos = [];
          data.partial = false;
          data.graphComplete = true;
          data.fragment = undefined;
          data.totals = { people: data.family.people.length, photos: 0 };
        }
        data.user.personId = large ? "f-0" : "e2e-memorial-person";
        data.treePreferences = {
          ...data.treePreferences,
          animateOnLoad: false,
          fragmentThreshold: 0,
          presentation: "flat",
        };
        await route.fulfill({ response, json: data });
      });
      await page.addInitScript(() => {
        const samples: Array<{ zoom: number; drawing: boolean }> = [];
        Object.assign(window, { __disabledDrawingFrames: samples });
        const visible = (element: HTMLElement) => {
          if (getComputedStyle(element).visibility !== "visible") return false;
          for (
            let current: HTMLElement | null = element;
            current;
            current = current.parentElement
          ) {
            const style = getComputedStyle(current);
            if (style.display === "none" || Number(style.opacity) === 0)
              return false;
          }
          return element.getClientRects().length > 0;
        };
        const sample = () => {
          const root = document.querySelector<HTMLElement>(".tree-canvas");
          const viewport = root?.querySelector<HTMLElement>(
            ".react-flow__viewport",
          );
          if (
            root &&
            viewport &&
            (Array.from(
              root.querySelectorAll<HTMLElement>(".flow-person"),
            ).some(visible) ||
              Array.from(
                root.querySelectorAll<HTMLElement>(
                  ".tree-gpu-scene, .tree-distant-portraits",
                ),
              ).some(
                (element) =>
                  Number(element.dataset.sceneNodes) > 0 && visible(element),
              ))
          )
            samples.push({
              zoom: new DOMMatrix(getComputedStyle(viewport).transform).a,
              drawing: /is-growing|is-growth-preparing/.test(root.className),
            });
          requestAnimationFrame(sample);
        };
        requestAnimationFrame(sample);
      });
      const zoom = () =>
        page
          .locator(".react-flow__viewport")
          .evaluate(
            (element) => new DOMMatrix(getComputedStyle(element).transform).a,
          );
      await page.goto("/tree");
      await expect.poll(zoom, { timeout: 30_000 }).toBeCloseTo(0.55, 2);
      if (cached) {
        await page.reload();
        await expect.poll(zoom, { timeout: 30_000 }).toBeCloseTo(0.55, 2);
      }
      const samples = await page.evaluate(
        () =>
          (
            window as typeof window & {
              __disabledDrawingFrames: Array<{
                zoom: number;
                drawing: boolean;
              }>;
            }
          ).__disabledDrawingFrames,
      );
      expect(samples.length).toBeGreaterThan(2);
      expect(samples.some((sample) => sample.drawing)).toBe(false);
      expect(samples[0].zoom).toBeLessThanOrEqual(isMobile ? 0.32 : 0.38);
      const backwards = samples
        .slice(1)
        .filter((sample, index) => sample.zoom + 0.001 < samples[index].zoom);
      expect(
        backwards,
        "the visible startup camera must not zoom out before its account flight",
      ).toEqual([]);
    });

test("startup drawing can be disabled personally without losing the account camera flight", async ({
  page,
}) => {
  await page.request.put("/api/tree-preferences", {
    data: DEFAULT_TREE_PREFERENCES,
  });
  await page.route("**/api/family?projection=overview", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    data.user.personId = "e2e-memorial-person";
    await route.fulfill({ response, json: data });
  });
  await page.addInitScript(() => {
    const state = window as typeof window & { __loadDrawingObserved?: boolean };
    state.__loadDrawingObserved = false;
    const sample = () => {
      if (
        document.querySelector(
          ".tree-canvas.is-growing, .tree-canvas.is-growth-preparing",
        )
      )
        state.__loadDrawingObserved = true;
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  try {
    await page.goto("/tree");
    const settings = page.getByRole("button", { name: "Настройки древа" });
    await expect(settings).toBeEnabled();
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __loadDrawingObserved?: boolean;
            }
          ).__loadDrawingObserved,
      ),
    ).toBe(true);
    await settings.click();
    const dialog = page.getByRole("dialog", { name: "Вид древа" });
    const toggle = dialog.getByRole("switch", {
      name: "Анимация при загрузке",
    });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/tree-preferences")).json())
            .animateOnLoad,
      )
      .toBe(false);
    await dialog.getByRole("button", { name: "Закрыть" }).click();
    await page.reload();
    await expect(page.locator(".tree-canvas")).toHaveAttribute(
      "data-layout-ready",
      "true",
    );
    await expect
      .poll(() =>
        page
          .locator(".react-flow__viewport")
          .evaluate(
            (element) => new DOMMatrix(getComputedStyle(element).transform).a,
          ),
      )
      .toBeCloseTo(0.55, 2);
    await expect
      .poll(() =>
        page.getByTestId("rf__node-e2e-memorial-person").evaluate((card) => {
          const viewport = card.closest(".react-flow")!.getBoundingClientRect();
          const person = card.getBoundingClientRect();
          return Math.hypot(
            person.x + person.width / 2 - viewport.x - viewport.width / 2,
            person.y + person.height / 2 - viewport.y - viewport.height / 2,
          );
        }),
      )
      .toBeLessThan(5);
    expect(
      await page.evaluate(
        () =>
          (
            window as typeof window & {
              __loadDrawingObserved?: boolean;
            }
          ).__loadDrawingObserved,
      ),
    ).toBe(false);
    await settings.click();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await expect
      .poll(
        async () =>
          (await (await page.request.get("/api/tree-preferences")).json())
            .animateOnLoad,
      )
      .toBe(true);
    await dialog.getByRole("button", { name: "Закрыть" }).click();
    await page.reload();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as typeof window & {
                __loadDrawingObserved?: boolean;
              }
            ).__loadDrawingObserved,
        ),
      )
      .toBe(true);
  } finally {
    await page.request.put("/api/tree-preferences", {
      data: DEFAULT_TREE_PREFERENCES,
    });
  }
});
