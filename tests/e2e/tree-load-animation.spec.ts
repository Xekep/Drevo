import { expect, test } from "@playwright/test";
import { DEFAULT_TREE_PREFERENCES } from "../../src/domain/tree-preferences";

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
